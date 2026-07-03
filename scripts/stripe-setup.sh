#!/usr/bin/env bash
# One-shot Stripe setup for ClawHub platform billing (M7). Given a Stripe secret
# key, it creates (idempotently) everything the app needs and prints — or writes —
# the five env vars. Run it ONCE; re-running is safe (it reuses what exists).
#
#   STRIPE_SECRET_KEY=sk_live_xxx ./scripts/stripe-setup.sh
#   STRIPE_SECRET_KEY=sk_live_xxx ./scripts/stripe-setup.sh --api-url https://api.useclawhub.com --write-env ~/clawhub/.env
#
# It creates:
#   • Product "ClawHub Pro" + a $20/mo per-seat price          → STRIPE_PRICE_PRO
#   • Billing meter clawhub_review_overage + $0.10 metered price → STRIPE_PRICE_REVIEW_OVERAGE
#   • Billing meter clawhub_verify + $2.00 metered price         → STRIPE_PRICE_VERIFY
#   • A webhook endpoint for the events the app handles          → STRIPE_WEBHOOK_SECRET
#
# The event names (clawhub_review_overage / clawhub_verify) MUST match what
# services/platform-billing.ts sends — this script sets them, so leave them alone.
# Needs: curl, jq. Use a STANDARD secret key (sk_live_… / sk_test_…) for setup —
# it needs write on products, prices, meters and webhooks.
set -euo pipefail

: "${STRIPE_SECRET_KEY:?set STRIPE_SECRET_KEY (your Stripe secret key)}"
KEY="$STRIPE_SECRET_KEY"
API_URL="https://api.useclawhub.com"
WRITE_ENV=""
while [ $# -gt 0 ]; do
  case "$1" in
    --api-url) API_URL="$2"; shift 2 ;;
    --write-env) WRITE_ENV="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

S="https://api.stripe.com/v1"
# Stripe call: `sc METHOD PATH [curl -d args...]`. Aborts on a Stripe error object.
sc() { local m="$1" p="$2"; shift 2; local out
  out="$(curl -s -X "$m" "$S/$p" -u "$KEY:" "$@")"
  if echo "$out" | jq -e '.error' >/dev/null 2>&1; then
    echo "Stripe error on $m $p:" >&2; echo "$out" | jq -r '.error.message' >&2; exit 1
  fi
  echo "$out"
}
say() { printf '  %s\n' "$*" >&2; }

echo "== ClawHub Stripe setup ($([ "${KEY#sk_test_}" != "$KEY" ] || [ "${KEY#rk_test_}" != "$KEY" ] && echo TEST || echo LIVE) mode) ==" >&2

# 1. Product (idempotent by metadata.clawhub=pro via the search API).
PRODUCT="$(sc GET "products/search" --data-urlencode "query=active:'true' AND metadata['clawhub']:'pro'" | jq -r '.data[0].id // empty')"
if [ -z "$PRODUCT" ]; then
  PRODUCT="$(sc POST products -d name="ClawHub Pro" -d "metadata[clawhub]=pro" | jq -r .id)"
  say "created product $PRODUCT"
else say "reusing product $PRODUCT"; fi

# Reuse-or-create a price by lookup_key. Args after $2 are the create -d flags.
price_by_lookup() { # price_by_lookup LOOKUP_KEY <create args...>
  local lk="$1"; shift
  local existing; existing="$(sc GET "prices" --data-urlencode "lookup_keys[]=$lk" -d limit=1 | jq -r '.data[0].id // empty')"
  if [ -n "$existing" ]; then echo "$existing"; return; fi
  sc POST prices -d lookup_key="$lk" "$@" | jq -r .id
}

# Reuse-or-create a billing meter by event_name.
meter_by_event() { # meter_by_event EVENT_NAME DISPLAY
  local ev="$1" disp="$2" existing
  existing="$(sc GET "billing/meters" -d limit=100 | jq -r --arg e "$ev" '.data[] | select(.event_name==$e and .status=="active") | .id' | head -1)"
  if [ -n "$existing" ]; then echo "$existing"; return; fi
  sc POST billing/meters \
    -d display_name="$disp" -d event_name="$ev" \
    -d "default_aggregation[formula]=sum" \
    -d "customer_mapping[type]=by_id" -d "customer_mapping[event_payload_key]=stripe_customer_id" \
    -d "value_settings[event_payload_key]=value" | jq -r .id
}

# 2. Pro seat price — $20/mo, per-seat (licensed; quantity = seats at checkout).
PRO_PRICE="$(price_by_lookup clawhub_pro -d product="$PRODUCT" -d currency=usd -d unit_amount=2000 -d "recurring[interval]=month" -d "recurring[usage_type]=licensed")"
say "pro price $PRO_PRICE"

# 3. Review-overage: meter + $0.10 metered price.
RMETER="$(meter_by_event clawhub_review_overage "ClawHub review overage")"; say "review meter $RMETER"
RPRICE="$(price_by_lookup clawhub_review_overage -d product="$PRODUCT" -d currency=usd -d unit_amount=10 -d "recurring[interval]=month" -d "recurring[usage_type]=metered" -d "recurring[meter]=$RMETER")"
say "review-overage price $RPRICE"

# 4. Verify: meter + $2.00 metered price.
VMETER="$(meter_by_event clawhub_verify "ClawHub verify run")"; say "verify meter $VMETER"
VPRICE="$(price_by_lookup clawhub_verify -d product="$PRODUCT" -d currency=usd -d unit_amount=200 -d "recurring[interval]=month" -d "recurring[usage_type]=metered" -d "recurring[meter]=$VMETER")"
say "verify price $VPRICE"

# 5. Webhook endpoint (idempotent by URL). The signing secret is only returned at
#    creation — if an endpoint for this URL already exists we can't re-read it.
WEBHOOK_URL="${API_URL%/}/api/v1/billing/stripe/webhook"
EXISTING_WH="$(sc GET "webhook_endpoints" -d limit=100 | jq -r --arg u "$WEBHOOK_URL" '.data[] | select(.url==$u) | .id' | head -1)"
if [ -n "$EXISTING_WH" ]; then
  WHSEC="<existing endpoint $EXISTING_WH — roll its signing secret in the Stripe dashboard, or delete it and re-run this script>"
  say "webhook already exists ($EXISTING_WH); leaving it"
else
  WH="$(sc POST webhook_endpoints -d url="$WEBHOOK_URL" \
    -d "enabled_events[]=checkout.session.completed" \
    -d "enabled_events[]=customer.subscription.created" \
    -d "enabled_events[]=customer.subscription.updated" \
    -d "enabled_events[]=customer.subscription.deleted" \
    -d "enabled_events[]=invoice.payment_failed")"
  WHSEC="$(echo "$WH" | jq -r .secret)"
  say "created webhook $(echo "$WH" | jq -r .id) → $WEBHOOK_URL"
fi

# ── Output ───────────────────────────────────────────────────────────────────
ENV_BLOCK=$(cat <<EOF
STRIPE_SECRET_KEY=$KEY
STRIPE_WEBHOOK_SECRET=$WHSEC
STRIPE_PRICE_PRO=$PRO_PRICE
STRIPE_PRICE_REVIEW_OVERAGE=$RPRICE
STRIPE_PRICE_VERIFY=$VPRICE
EOF
)

if [ -n "$WRITE_ENV" ]; then
  touch "$WRITE_ENV"
  while IFS= read -r line; do
    k="${line%%=*}"
    if grep -q "^${k}=" "$WRITE_ENV"; then
      # Portable in-place edit (works on GNU + BSD sed) via a temp file.
      tmp="$(mktemp)"; awk -v k="$k" -v v="$line" 'BEGIN{FS="="} $1==k{print v; next} {print}' "$WRITE_ENV" > "$tmp" && mv "$tmp" "$WRITE_ENV"
    else
      printf '%s\n' "$line" >> "$WRITE_ENV"
    fi
  done <<< "$ENV_BLOCK"
  echo "" >&2
  echo "✓ wrote 5 vars into $WRITE_ENV — now: docker compose up -d --force-recreate api" >&2
else
  echo "" >&2
  echo "Add these to ~/clawhub/.env (then: docker compose up -d --force-recreate api):" >&2
  echo "" >&2
  printf '%s\n' "$ENV_BLOCK"
fi
