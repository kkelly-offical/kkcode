  - longagent.mjs — runLongAgent 优先检查 args.longagentImpl，"4stage" 直接走 4-stage，"hybrid" 直接走
  hybrid，否则走原有 config 逻辑
  - engine.mjs — executeTurn 新增 longagentImpl 参数并透传给 runLongAgent
  - repl.mjs — 新增 /longagent 4stage / /longagent hybrid 子指令，写入 state.longagentImpl，并在 executePromptTurn
  里传给 executeTurn；/status 也会显示当前 impl

  用法：
  /longagent 4stage    # 切换到 4-stage 实现
  /longagent hybrid    # 切回 hybrid（默认）
  /longagent# 仅切换到 longagent 模式，不改变 impl
  /status              # 可看到 longagent.impl=4stage


  为kkcode添加暂停功能，允许用户在对话中途输入新的指令，或者输入/调整配置，然后若用户输入Esc可以暂停对话，直到用户发送新的指令

  kkcode是我制作的CLI ai code agent 现在为kkcode做一个开始页面：用户第一次安装启动的时候可以让用户填表（如常用技术栈、默认设计风格倾向、一些其他需要kkcode记住的信息——注意并非rule），表单也可以填写“我是新手，全听kkcode的”，使用默认配置