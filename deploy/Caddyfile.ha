:18275 {
  reverse_proxy gateway:18272 gateway-2:18272 {
    lb_policy round_robin
    health_uri /health
    health_interval 5s
    health_timeout 2s
    health_headers {
      Host {$KKCODE_GATEWAY_HOST}
    }
    fail_duration 10s
    max_fails 1
    transport http {
      dial_timeout 2s
    }
  }
}
