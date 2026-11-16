"""An example training loop against the hospital environment, runnable offline
with a stub policy. Replace stub_policy with your model's policy.

    ENV_URL=http://127.0.0.1:3000 ENV_TOKEN=hd_env_... python example_train.py
"""
import os
import sys

from hospital_env import HospitalEnv, VectorEnv, stub_policy

BASE = os.environ.get("ENV_URL", "http://127.0.0.1:3000")
TOKEN = os.environ.get("ENV_TOKEN", "")
if not TOKEN:
    sys.exit("Set ENV_TOKEN to a key made in Administration -> Environment keys")

env = HospitalEnv(BASE, TOKEN)
catalogue = env.tasks()
practice = [t for t in catalogue["tasks"] if t["part"] == "practice"]
if not practice:
    sys.exit("No practice tasks are reachable with this key")
print(f"environment {catalogue['versions']['environment']}, grading {catalogue['versions']['grading']}, {len(practice)} practice tasks")

for epoch in range(2):
    vec = VectorEnv(env, n=4)
    results = vec.run(lambda i: {"task": practice[i % len(practice)]["id"], "run": "example-run", "seed": epoch * 100 + i, "condition": "autonomous"}, stub_policy)
    mean = sum(r["totalReward"] or 0 for r in results) / len(results)
    print(f"epoch {epoch}: {len(results)} episodes, mean reward {mean:.3f}, steps {[r['steps'] for r in results]}")
    for r in results:
        safety = r["rewardBreakdown"]["safety"]
        print(f"  {r['episodeId'][:8]} reward {r['totalReward']} checks {r['rewardBreakdown']['chartChecks']['value']} safety violations {safety['violations']} trace {r['links']['trace']}")
    # A real trainer updates its policy here from the rewards and the traces.
