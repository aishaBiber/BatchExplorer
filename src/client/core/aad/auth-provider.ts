import {
    AccountInfo,
    AuthenticationResult,
    PublicClientApplication
} from "@azure/msal-node";
import { log } from "@batch-flask/utils";
import { BatchExplorerApplication } from "..";
import { SecureDataStore } from "../secure-data-store";
import { AADConfig } from "./aad-config";
import { defaultTenant, unretryableAuthCodeErrors, TenantPlaceholders } from "./aad-constants";
import { AuthorizeError } from "./authentication";
import MSALCachePlugin from "./msal-cache-plugin";

const MSAL_SCOPES = ["user_impersonation"];

export type AuthorizationResult = AuthenticationResult;

export type AuthCodeCallback =
    (url: string, tenant: string, silent?: boolean) => Promise<string>;

/**
 * Provides authentication services
 */
export default class AuthProvider {
    private _clients: StringMap<PublicClientApplication> = {};
    private _accounts: StringMap<AccountInfo> = {};
    private _cachePlugin: MSALCachePlugin;
    private _logoutPromise?: Promise<void>;
    private _primaryClient?: PublicClientApplication;

    // Used for reauthentication to associated tenants
    private _primaryUsername?: string;

    constructor(
        protected app: BatchExplorerApplication,
        protected config: AADConfig
    ) {
        this._cachePlugin =
            new MSALCachePlugin(app.injector.get(SecureDataStore));
    }

    /**
     * Retrieves an access token for a tenant and resource
     *
     * Will attempt to retrieve the token silently if an account exists in the
     * cache, but will fall back to interactive access token retrieval.
     *
     * @param resourceURI: The resource URI for which to get an access token
     * @param tenantId: The tenant from which to get the token (defaults to the
     *     default tenant)
     * @param authCodeCallback Handles interactive authentication code retrieval
     */
    public async getToken(options: {
        resourceURI: string,
        tenantId?: string,
        forceRefresh?: boolean,
        authCodeCallback: AuthCodeCallback
    }): Promise<AuthorizationResult> {
        const {
            resourceURI,
            tenantId = defaultTenant,
            forceRefresh = false,
            authCodeCallback
        } = options;

        if (this._logoutPromise) {
            await this._logoutPromise;
        }

        /**
         * KLUDGE: msal.js does not handle well access tokens across multiple
         * tenants within the same cache. It lets you specify a different
         * authority per request but it returns the same access token.
         *
         * Until this is resolved, we use one client application per tenant.
         */
        const client = await this._getClient(tenantId);

        const authRequest = this._authRequest(resourceURI, tenantId);
        try {
            log.debug(`[${tenantId}] Trying to silently acquire token`);
            const account = await this._getAccount(tenantId);

            if (!account) {
                throw new Error(
                    "[internal] No account for silent token acquisition"
                );
            }
            const result = await client.acquireTokenSilent({
                ...authRequest, account, forceRefresh
            });
            return result;
        } catch (silentTokenException) {
            log.debug(`[${tenantId}] Trying silent auth code flow (${silentTokenException})`);
            let url, code;

            try {
                // Attempt to get authorization code silently
                url = await client.getAuthCodeUrl(
                    { ...authRequest, prompt: "none" }
                );
                code = await authCodeCallback(url, tenantId, true);
            } catch (silentAuthException) {
                log.debug(`[${tenantId}] Silent auth failed (${silentAuthException})`)
                if (silentAuthException instanceof AuthorizeError &&
                    !this._isTenantAuthRetryable(silentAuthException)) {
                    log.warn(`Fatal authentication exception for ${tenantId}:` +
                        ` ${silentAuthException} (non-retryable error code ` +
                        silentAuthException.errorCodes.join(";") + `)`);
                    throw silentAuthException;
                }
                log.debug(
                    `[${tenantId}] Trying interactive auth code flow (${silentAuthException})`);
                url = await client.getAuthCodeUrl({
                    ...authRequest,
                    domainHint: tenantId,
                    loginHint: this._primaryUsername
                });

                code = await authCodeCallback(url, tenantId);
            }

            const result: AuthorizationResult =
                await client.acquireTokenByCode({ ...authRequest, code });
            this._processAccountInfo(result.account);
            return result;
        }
    }

    public async logout(tenantId?: string): Promise<void> {
        this._logoutPromise = this._removeAccounts(tenantId);
        return this._logoutPromise;
    }

    private async _removeAccounts(tenantId?: string): Promise<void> {
        const cache = this._primaryClient?.getTokenCache();
        if (!cache) {
            return;
        }
        const accounts = await cache.getAllAccounts();
        if (tenantId) {
            for (const account of accounts) {
                if (account.tenantId === tenantId) {
                    await cache.removeAccount(account);
                    break;
                }
            }
            delete this._accounts[tenantId];
        } else {
            for (const account of accounts) {
                await cache.removeAccount(account);
            }
            this._accounts = {};
            this._clients = {};
            this._primaryClient = undefined;
            this._primaryUsername = undefined;
        }
    }

    protected async _getClient(tenantId: string):
        Promise<PublicClientApplication> {
        if (tenantId in this._clients) {
            return this._clients[tenantId];
        }
        const client = await this._createClient(tenantId);
        if (!this._primaryClient) {
            this._primaryClient = client;
        }
        this._clients[tenantId] = client;
        return client;
    }

    private async _createClient(tenantId: string):
        Promise<PublicClientApplication> {
        const proxyUrl = await this._loadProxyUrl();

        if (proxyUrl) {
            log.info(`[${tenantId}] Proxying auth endpoints through ` +
                proxyUrl);
        }

        const authority =
            `${this.app.properties.azureEnvironment.aadUrl}${tenantId}/`;

        return new PublicClientApplication({
            system: {
                proxyUrl
            },
            auth: {
                clientId: this.config.clientId,
                authority,
                knownAuthorities: [authority]
            },
            cache: {
                cachePlugin: this._cachePlugin
            }
        });
    }

    private async _loadProxyUrl() {
        const proxySettings = await this.app.proxySettings.settings;
        const protocolUrl = proxySettings?.https ?? proxySettings?.http;
        return protocolUrl?.toString();
    }

    private async _getAccount(tenantId: string): Promise<AccountInfo> {
        if (tenantId in this._accounts) {
            return this._accounts[tenantId];
        }
        const cache = this._clients[tenantId].getTokenCache();
        const accounts: AccountInfo[] = await cache.getAllAccounts();
        let homeAccountId = null;
        for (const account of accounts) {
            if (account.tenantId === tenantId) {
                return this._accounts[tenantId] = account;
            } else if (!homeAccountId) {
                homeAccountId = account.homeAccountId;
            }
        }

        /* SPECIAL CASE: If the tenant is one of the tenant placeholders (e.g.,
         * "common"), fallback to the home tenant account, since the tenant in
         * the account dictionary are always resolved IDs.
         */
        if (tenantId in TenantPlaceholders) {
            return this._accounts[tenantId] =
                await cache.getAccountByHomeId(homeAccountId);
        }

        throw new Error(
            `Unable to find a valid AAD account for tenant ${tenantId}`
        );
    }

    private _processAccountInfo(account: AccountInfo) {
        if (!this._primaryUsername) {
            this._primaryUsername = account.username;
        }
    }

    private _isTenantAuthRetryable(error: AuthorizeError) {
        for (const code of error.errorCodes) {
            if (unretryableAuthCodeErrors.includes(code)) {
                return false;
            }
        }
        return true;
    }

    private _getScopes(resourceURI: string): string[] {
        switch (resourceURI) {
            case this.app.properties.azureEnvironment.arm:
            case this.app.properties.azureEnvironment.batch:
                return MSAL_SCOPES.map(s => `${resourceURI}/${s}`);
            default:
                return MSAL_SCOPES.map(s => `${resourceURI}${s}`);
        }
    }

    private _authRequest(resourceURI: string, tenantId?: string) {
        return {
            scopes: this._getScopes(resourceURI),
            redirectUri: this.config.redirectUri,
            authority:
                `${this.app.properties.azureEnvironment.aadUrl}${tenantId}/`
        };
    }
}
