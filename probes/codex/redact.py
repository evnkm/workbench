# Redact a probe transcript for committing: strips local paths, identifiers
# tied to this machine or account, stderr noise, and high-volume deltas.
import json, re, sys
src, dst, scratch = sys.argv[1], sys.argv[2], sys.argv[3]
SKIP = {"thread/tokenUsage/updated", "account/rateLimits/updated", "mcpServer/startupStatus/updated", "remoteControl/status/changed"}
out = []
for line in open(src):
    r = json.loads(line)
    if r["dir"] in ("stderr", "in-raw"):
        continue
    m = r["msg"]
    if isinstance(m, dict) and m.get("method") in SKIP:
        continue
    s = json.dumps(r)
    s = s.replace(scratch, "/tmp/probe")
    s = re.sub(r'"(installationId|serverName|sessionId|codexHome|path|userAgent)": "[^"]*"', r'"\1": "<redacted>"', s)
    s = re.sub(r'"planType": "[^"]*"', '"planType": "<redacted>"', s)
    s = re.sub(r"/tmp/claude-1000(/-home-ubuntu)?(/[^ \"/]*)?", "/tmp/session", s)
    out.append(s)
open(dst, "w").write("\n".join(out) + "\n")
print(dst, len(out), "records")
