const webpackConfig = require("./config/webpack.config.test");

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";

// Only enable coverage if env is defined(So we don't enable it in watch mode as it duplicate logs)
const coverageReporters = process.env.COVERAGE ? ["coverage", "junit"] : [];

// Karma config for testing the code running the browser environemnt.
// For the client testing use the mocha command line.
module.exports = function(config) {
    config.set({
        basePath: ".",
        frameworks: ["jasmine"],
        files: [
            {
                pattern: "./test/app/spec-entry.js",
                watched: false
            },
            {
                pattern: "./src/test/fixtures/**/*",
                watched: false,
                included: false,
                served: true,
                // Important, if karma cache the encoding files it will remove the BOM which fails the tests
                nocache: true,
            }
        ],

        // proxied base paths
        proxies: {
            "/fixtures/": "/base/src/test/fixtures/"
        },

        port: 9876,

        logLevel: config.LOG_INFO,
        browserConsoleLogOptions: {
            level: "log",
        },
        colors: true,

        autoWatch: false,
        autoWatchBatchDelay: 1000,

        browsers: ["CustomElectron"],
        browserNoActivityTimeout: 3000000,
        customLaunchers: {
            CustomElectron: {
                base: "Electron",
                flags: ["--enable-precise-memory-info"],
                browserWindowOptions: {
                    show: true,
                    webPreferences: {
                        nodeIntegration: true,
                        contextIsolation: false,
                        enableRemoteModule: true,
                    }
                }
            }
        },
        electronOpts: {
            title: "Banana",
            "webPreferences": {
                "blinkFeatures": "PreciseMemoryInfo",
            }
        },

        // Coverage reporter generates the coverage
        reporters: ["mocha", ...coverageReporters],

        preprocessors: {
            "test/app/spec-entry.js": ["coverage", "webpack", "sourcemap"],
        },
        client: {
            useIframe: false,
            jasmine: {
                random: false,
            },
        },
        webpack: webpackConfig,
        webpackMiddleware: {
            stats: "errors-only",
        },
        browserDisconnectTimeout: "4000",
        singleRun: true,
        mochaReporter: {
            output: "autowatch",
            reportSlowerThan: 200,
        },
        coverageReporter: {
            dir: "./coverage",
            reporters: [
                { type: "json", subdir: ".", file: "coverage.json" },
                { type: "html", subdir: "./html" },
                { type: "cobertura", subdir: ".", file: "cobertura.xml" },
            ]
        },
        junitReporter: {
            outputDir: "./coverage"
        }
    });
};
