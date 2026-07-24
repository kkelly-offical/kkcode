export default [
  {
    files: ["src/**/*.mjs", "scripts/**/*.mjs", "test/**/*.mjs"],
    ignores: ["coverage/**", "dist/**", "node_modules/**"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module"
    },
    rules: {
      "constructor-super": "error",
      "for-direction": "error",
      "getter-return": "error",
      "no-async-promise-executor": "error",
      "no-class-assign": "error",
      "no-const-assign": "error",
      "no-dupe-args": "error",
      "no-dupe-class-members": "error",
      "no-dupe-else-if": "error",
      "no-dupe-keys": "error",
      "no-ex-assign": "error",
      "no-import-assign": "error",
      "no-obj-calls": "error",
      "no-self-assign": "error",
      "no-setter-return": "error",
      "no-sparse-arrays": "error",
      "no-unreachable": "error",
      "no-unreachable-loop": "error",
      "no-unsafe-finally": "error",
      "no-unsafe-negation": "error",
      "use-isnan": "error",
      "valid-typeof": "error"
    }
  }
]
