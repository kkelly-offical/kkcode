现在支持直接在终端配置环境变量到config.yaml，可以实现类似CC的开箱即用
：yaml可以这么写了
anthropic:
    type: anthropic
    base_url: ANTHROPIC_BASE_URL
    api_key_env: ANTHROPIC_API_KEY
    default_model: ANTHROPIC_MODEL
    models:
      - ANTHROPIC_MODEL