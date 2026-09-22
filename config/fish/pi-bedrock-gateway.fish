# pi-bedrock-gateway.fish — route pi's native amazon-bedrock provider through
# the tailnet Aperture gateway instead of real AWS.
#
# WHY: pi's amazon-bedrock provider is the bundled @aws-sdk/client-bedrock-
# runtime, which honors this endpoint-override env var itself (a standard AWS
# SDK v3 feature, not pi-specific). Without it, pi signs requests for real AWS
# Bedrock and gets "UnrecognizedClientException: security token invalid" --
# verified directly. With it, requests go to the gateway's own
# /bedrock/model/{id}/converse-stream route instead, the same path Claude
# Code already reaches Claude through on this machine (see its
# ANTHROPIC_BEDROCK_BASE_URL in ~/.claude/settings.json) -- pi has no
# Claude-Code-shaped equivalent of that setting, so this is pi's own version
# of the same fix, via the AWS SDK's own mechanism rather than a pi-specific
# one. No skip-auth flag needed: verified end-to-end, real round trip.
#
# This is what gives bare `pi` working Claude models again after retiring the
# standing @aliou/pi-ts-aperture extension (see docs/COHESION.md) -- OpenAI
# models still go through the `aperture` launcher, since the gateway serves
# them differently and pi has no built-in OpenAI-via-proxy equivalent wired
# up here.
#
# Auto-sourced by fish from ~/.config/fish/conf.d/ — installed here by
# mypi/bootstrap.sh, versioned at mypi/config/fish/pi-bedrock-gateway.fish.
set -gx AWS_ENDPOINT_URL_BEDROCK_RUNTIME http://ai-gateway.tail692491.ts.net/bedrock
