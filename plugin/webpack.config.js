import path from 'path';
import { fileURLToPath } from 'url';
import webpack from 'webpack';
import dotenv from 'dotenv';
import process from 'process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment variables based on build environment
const KEYS = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'API_BASE_URL', 'WEBAPP_BASE_URL'];

const loadEnv = (buildEnv) => {
    const envFile = `.env.${buildEnv}`;
    const result = dotenv.config({ path: envFile });

    // If env file doesn't exist (like in CI), use process.env directly
    const vars = result.error
        ? Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
        : result.parsed;

    /*
     * Refuse to build a bundle that cannot start.
     *
     * These are substituted at build time, and an absent one compiles to an
     * empty string rather than to nothing — which looks like a successful
     * build and produces an extension that dies on load: the inherited auth
     * component constructs a Supabase client on mount, and `getSupabaseConfig`
     * throws on an empty URL, taking the whole React tree with it.
     *
     * That shipped once, as 0.1.19: `.env.production` did not exist, every
     * value compiled empty, `npm run build` said nothing, and the plugin would
     * not open. A build failing here is the cheapest possible version of that
     * discovery.
     */
    const missing = KEYS.filter((k) => !vars?.[k]);
    if (missing.length) {
        throw new Error(
            `webpack: ${missing.join(', ')} missing for the "${buildEnv}" build.\n` +
            `Create ${envFile} (copy ${envFile}.example), or set them in the ` +
            `environment. They are compiled into the bundle, and an empty one ` +
            `makes an extension that installs cleanly and then does not start.`
        );
    }

    return vars;
};

export default (env, argv) => {
    const mode = argv.mode || 'development';
    // Use custom BUILD_ENV or fall back to webpack mode
    const buildEnv = process.env.BUILD_ENV || mode;
    const envVars = loadEnv(buildEnv);

    return {
        mode,
        target: 'web',
        entry: './react/index.tsx',
        devtool: mode === 'development' ? 'inline-source-map' : false,
        output: {
            path: path.resolve(__dirname, 'addon', 'content'),
            filename: 'reactBundle.js',
            library: 'AlphainZReact',
            libraryTarget: 'umd',
            globalObject: 'this',
            umdNamedDefine: true
        },
        module: {
            rules: [
            {
                test: /\.(js|jsx|ts|tsx)$/,
                exclude: /node_modules/,
                use: {
                    loader: 'babel-loader',
                    options: {
                        presets: [
                            ['@babel/preset-env', { targets: { esmodules: false } }],
                            '@babel/preset-react',
                            '@babel/preset-typescript'
                        ]
                    }
                }
            }
            ]
        },
        resolve: {
            extensions: ['.js', '.jsx', '.ts', '.tsx'],
            alias: {
                '@beaver/agent-core': path.resolve(__dirname, 'packages', 'agent-core', 'src'),
                '@beaver/agent-ui': path.resolve(__dirname, 'packages', 'agent-ui', 'src')
            },
        },
        plugins: [
            new webpack.DefinePlugin({
                'process.env.NODE_ENV': JSON.stringify(mode),
                'process.env.BUILD_ENV': JSON.stringify(buildEnv),
                'process.env.SUPABASE_URL': JSON.stringify(envVars.SUPABASE_URL),
                'process.env.SUPABASE_ANON_KEY': JSON.stringify(envVars.SUPABASE_ANON_KEY),
                'process.env.API_BASE_URL': JSON.stringify(envVars.API_BASE_URL),
                'process.env.WEBAPP_BASE_URL': JSON.stringify(envVars.WEBAPP_BASE_URL)
            })
        ]
    };
};