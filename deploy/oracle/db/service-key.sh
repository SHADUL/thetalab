#!/usr/bin/env bash
# Prints NOTHING. Writes the self-hosted service_role JWT (HS256, signed with PGRST_JWT_SECRET)
# to /opt/thetalab/data/migration/service_role.jwt (mode 600) for the cut-over step.
set -euo pipefail
cd /opt/thetalab
umask 077
sudo docker run --rm --env-file db.env node:24-alpine node -e '
const c=require("crypto"),b=(o)=>Buffer.from(JSON.stringify(o)).toString("base64url");
const h=b({alg:"HS256",typ:"JWT"}),p=b({role:"service_role",iss:"thetalab-self-hosted",iat:Math.floor(Date.now()/1000)});
const s=c.createHmac("sha256",process.env.PGRST_JWT_SECRET).update(h+"."+p).digest("base64url");
process.stdout.write(h+"."+p+"."+s);' > data/migration/service_role.jwt
echo "service key written ($(wc -c < data/migration/service_role.jwt) bytes, mode $(stat -c %a data/migration/service_role.jwt))"
