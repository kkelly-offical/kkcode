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
  },
  // 1.0.0 阶段 4（架构 §3/§4.2.2）：分层边界进 lint。frontends 只允许 import
  // src/kernel/index.mjs facade；deep-import 内核内部文件即 error。
  // scripts/check-boundaries.mjs 是同一规则的脚本兜底（同时覆盖动态 import 与
  // kernel→frontends 反向），两边任一命中都过不了 CI。
  {
    files: ["src/repl.mjs", "src/repl/**/*.mjs", "src/ui/**/*.mjs", "src/commands/**/*.mjs", "src/cli/**/*.mjs"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          regex: "^\\.{1,2}/(?:[^\"']*/)?kernel/(?!index\\.mjs$)",
          message: "frontends 只允许 import src/kernel/index.mjs facade（docs/architecture-kernel-sdk-1.0.0.md §4.2.2）；请改从 ../kernel/index.mjs 取用"
        }]
      }]
    }
  },
  // 反向：kernel 不得 import 任何 frontend 文件（层级倒置防回归，M3 耦合点 13–15）。
  {
    files: ["src/kernel/**/*.mjs"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          regex: "^\\.{1,2}/(?:\\.\\./)*(repl\\.mjs|repl/|ui/|commands/|cli/|theme/)",
          message: "kernel 不得 import frontends（repl/ui/commands/cli/theme，架构 §3 依赖方向严格单向）"
        }]
      }],
      // 1.0.0 阶段 5（架构 §4.2.3，对照 Codex core 的 deny(print_stdout)）：
      // kernel 不得直写 stdout —— 用户可见输出走 kernel.events / 宿主 handler。
      // console.error/warn 写 stderr，是 headless JSONL 契约的诊断通道，允许；
      // process.stdout.isTTY 等读取不受影响。scripts/check-boundaries.mjs 的
      // findKernelStdoutViolations 是同一规则的脚本兜底。
      "no-restricted-syntax": ["error",
        {
          selector: "CallExpression[callee.object.name='console'][callee.property.name=/^(log|info|debug|dir)$/]",
          message: "kernel 禁止 console.log/info/debug/dir（stdout 直写，架构 §4.2.3）；用户可见输出走 kernel.events，诊断用 console.error/warn"
        },
        {
          selector: "CallExpression[callee.object.object.name='process'][callee.object.property.name='stdout'][callee.property.name='write']",
          message: "kernel 禁止 process.stdout.write（架构 §4.2.3）；headless stdout 是纯 JSONL 契约面（docs/headless-jsonl-contract.md）"
        }
      ]
    }
  }
]
