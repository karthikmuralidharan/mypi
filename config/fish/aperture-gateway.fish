# aperture-gateway.fish — the one place this machine's Aperture gateway
# hostname lives, plus everything derived from it.
#
# WHY ONE FILE: before the standing @aliou/pi-ts-aperture extension was
# retired (see docs/CHANGELOG.md), its config file was the single shared
# source other tools read the gateway host from (extensions/websearch/
# explicitly did this, so there was "one place to change the endpoint rather
# than two that can drift apart" -- its own words). Removing that file without
# a replacement would have left every consumer hardcoding the same hostname
# independently, silently drifting the next time it changes. This file is
# that replacement: APERTURE_GATEWAY_HOST is the canonical value, and
# anything else that needs this host derives from the variable, not from a
# second copy of the literal string.
#
# AWS_ENDPOINT_URL_BEDROCK_RUNTIME: pi's native amazon-bedrock provider is the
# bundled @aws-sdk/client-bedrock-runtime, which honors this endpoint-override
# env var itself (a standard AWS SDK v3 feature, not pi-specific). Without it,
# pi signs requests for real AWS Bedrock and gets "UnrecognizedClientException:
# security token invalid" -- verified directly. With it, requests go to the
# gateway's own /bedrock/model/{id}/converse-stream route instead, the same
# path Claude Code already reaches Claude through on this machine (see its
# ANTHROPIC_BEDROCK_BASE_URL in ~/.claude/settings.json) -- pi has no
# Claude-Code-shaped equivalent of that setting, so this is pi's own version
# of the same fix, via the AWS SDK's own mechanism rather than a pi-specific
# one. No skip-auth flag needed: verified end-to-end, real round trip.
#
# extensions/websearch's `web_research` tool reads APERTURE_GATEWAY_HOST too
# (falls back to it when ~/.pi/agent/extensions/websearch.json sets no
# baseUrl of its own) -- see loadResearchConfig() there.
#
# Auto-sourced by fish from ~/.config/fish/conf.d/ — installed here by
# mypi/bootstrap.sh, versioned at mypi/config/fish/aperture-gateway.fish.
set -gx APERTURE_GATEWAY_HOST http://ai-gateway.tail692491.ts.net
set -gx AWS_ENDPOINT_URL_BEDROCK_RUNTIME "$APERTURE_GATEWAY_HOST/bedrock"
