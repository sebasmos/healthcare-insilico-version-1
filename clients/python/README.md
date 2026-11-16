# Python client

A small client for the environment API: `reset`, `step`, `state`, `close`, `tasks`, MCP calls, and `VectorEnv` for N parallel episodes. Standard library only (Python 3.9 or later). It is not installed by `npm install`.

```
cd clients/python
ENV_URL=http://127.0.0.1:3000 ENV_TOKEN=hd_env_... python example_train.py
```

Make a key in the EHR under Administration → Environment keys (the server must run with `ENV_API_ENABLED=true`, for example `npm run env:serve`). The full reference, determinism rules, budgets, rate limits and errors are in `docs/ENVIRONMENT-API.md`.
