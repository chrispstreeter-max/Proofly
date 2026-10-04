/**
 * This is intended to be a basic starting point for linting in your app.
 * It relies on recommended configs out of the box for simplicity, but you can
 * and should modify this configuration to best suit your team's needs.
 */

/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    ecmaFeatures: {
      jsx: true,
    },
  },
  env: {
    browser: true,
    commonjs: true,
    es6: true,
  },
  ignorePatterns: ["!**/.server", "!**/.client"],

  // Base config
  extends: ["eslint:recommended"],

  overrides: [
    // React
    {
      files: ["**/*.{js,jsx,ts,tsx}"],
      plugins: ["react", "jsx-a11y"],
      extends: [
        "plugin:react/recommended",
        "plugin:react/jsx-runtime",
        "plugin:react-hooks/recommended",
        "plugin:jsx-a11y/recommended",
      ],
      settings: {
        react: {
          version: "detect",
        },
        formComponents: ["Form"],
        linkComponents: [
          { name: "Link", linkAttribute: "to" },
          { name: "NavLink", linkAttribute: "to" },
        ],
        "import/resolver": {
          typescript: {},
        },
      },
      rules: {
        "react/no-unknown-property": ["error", { ignore: ["variant"] }],
      },
    },

    // Typescript
    {
      files: ["**/*.{ts,tsx}"],
      plugins: ["@typescript-eslint", "import"],
      parser: "@typescript-eslint/parser",
      settings: {
        "import/internal-regex": "^~/",
        "import/resolver": {
          node: {
            extensions: [".ts", ".tsx"],
          },
          typescript: {
            alwaysTryTypes: true,
          },
        },
      },
      extends: [
        "plugin:@typescript-eslint/recommended",
        "plugin:import/recommended",
        "plugin:import/typescript",
      ],
    },

    // Tenant boundary: merchant data is only reachable through app/lib/tenant.server.ts (withTenant + RLS).
    {
      files: ["app/**/*.{ts,tsx}"],
      excludedFiles: [
        "app/db.server.ts",
        "app/shopify.server.ts", // Shopify session storage
        "app/lib/tenant.server.ts", // shops table + tenant transactions
        "app/routes/webhooks.app.uninstalled.tsx", // sessions table only
        "app/routes/webhooks.app.scopes_update.tsx", // sessions table only
        "app/lib/http.server.ts", // rate_limits table only (hashed keys, not merchant data)
      ],
      rules: {
        "no-restricted-imports": ["error", { patterns: [{ group: ["**/db.server", "../db.server", "./db.server"], message: "Access merchant data through withTenant() in app/lib/tenant.server.ts." }] }],
      },
    },

    // Node
    {
      files: [
        ".eslintrc.cjs",
        "vite.config.{js,ts}",
        ".graphqlrc.{js,ts}",
        "shopify.server.{js,ts}",
        "**/*.server.{js,ts}",
      ],
      env: {
        node: true,
      },
    },
  ],
  globals: {
    shopify: "readonly"
  },
};
