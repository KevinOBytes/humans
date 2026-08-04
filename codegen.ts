import type { CodegenConfig } from "@graphql-codegen/cli";

const config: CodegenConfig = {
  hooks: {
    afterAllFileWrite: ["prettier --write"],
  },
  schema: "src/graphql/schema.ts",
  documents: [
    "src/graphql/operations/**/*.graphql",
    "!src/graphql/generated/**/*",
  ],
  ignoreNoDocuments: false,
  generates: {
    "src/graphql/generated/": {
      preset: "client",
      presetConfig: {
        persistedDocuments: true,
      },
      config: {
        documentMode: "string",
        enumsAsTypes: true,
        scalars: {
          Date: { input: "string", output: "string" },
          DateTime: { input: "string", output: "string" },
          JSON: { input: "unknown", output: "unknown" },
          UUID: { input: "string", output: "string" },
        },
        strictScalars: true,
        useTypeImports: true,
      },
    },
  },
};

export default config;
