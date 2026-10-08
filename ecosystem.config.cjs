{
  "apps": [
    {
      "name": "agy-proxy",
      "script": "server.js",
      "cwd": "/root/agy-proxy",
      "interpreter": "node",
      "instances": 1,
      "exec_mode": "fork",
      "autorestart": true,
      "max_restarts": 20,
      "min_uptime": 10000,
      "restart_delay": 2000,
      "max_memory_restart": "600M",
      "out_file": "/root/.pm2/logs/agy-proxy-out.log",
      "error_file": "/root/.pm2/logs/agy-proxy-error.log",
      "merge_logs": true,
      "time": true,
      "env": {
        "AGY_PROXY_PORT": "3611",
        "AGY_PROXY_HOST": "127.0.0.1",
        "AGY_CWD": "/root/agy-proxy/work",
        "AGY_MAX_CONCURRENT": "3",
        "AGY_TIMEOUT_MS": "300000"
      }
    }
  ]
}
