# Agent operations

The Agent Dashboard and everything behind it: agents and their permissions, tasks and task sets, studies, evaluation (shadow, human in the loop, autonomous, red team), the reinforcement learning environment and training runs, ablation, grading, benchmarks, traces and the model adapters.

- `server/`: code that runs on the server.
- `web/`: pages and scripts the browser loads. The path under `web/` is the address: `web/ehr/app.js` is served at `/ehr/app.js`.
