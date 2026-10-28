import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// The write boundary (master plan §5): nothing but executor/ may import the
// PayPal write client. evals/boundary.test.ts checks the same rule in tests.
const writeClientBan = {
  "no-restricted-imports": [
    "error",
    {
      patterns: [
        {
          group: ["**/paypal/write-client", "**/paypal/write-client.*", "@/paypal/write-client"],
          message: "Only executor/ may import the PayPal write client (master plan §5).",
        },
      ],
    },
  ],
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  { rules: writeClientBan },
  { files: ["executor/**"], rules: { "no-restricted-imports": "off" } },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // William's UI prototype (PR #1): plain JS, not part of the build
    "prototype/**",
  ]),
]);

export default eslintConfig;
