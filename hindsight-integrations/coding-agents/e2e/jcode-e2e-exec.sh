#!/bin/sh
# Point jcode at the stub model, then run one prompt.
#
# jcode's OpenAI-compatible provider takes its endpoint from the environment
# (JCODE_OPENAI_COMPAT_API_BASE), so unlike Droid and ZCode no config file has to be rendered.
# One thing still cannot be passed straight through: jcode accepts a plain-http base URL only
# for `localhost`, a `.local` name, or a bare IP address, and the stub is reached as
# `http://host.docker.internal:<port>`. A DNS name over http is rejected with a warning and the
# provider falls back to its default endpoint, so the run would never reach the stub. Resolve the
# name to its address here instead.
set -eu

: "${HINDSIGHT_STUB_BASE_URL:?missing stub model base URL}"

host=$(printf '%s' "$HINDSIGHT_STUB_BASE_URL" | sed -E 's#^https?://([^:/]+).*#\1#')
addr=$(getent hosts "$host" | awk 'NR==1 {print $1}')
: "${addr:?could not resolve the stub model host}"
# An IPv6 literal needs brackets inside a URL.
case "$addr" in *:*) addr="[$addr]" ;; esac
base=$(printf '%s' "$HINDSIGHT_STUB_BASE_URL" | sed -E "s#^(https?://)[^:/]+#\1${addr}#")

export JCODE_OPENAI_COMPAT_API_BASE="$base"
export JCODE_OPENAI_COMPAT_DEFAULT_MODEL="hindsight-e2e-stub"
export OPENAI_COMPAT_API_KEY="hindsight-e2e"
export JCODE_NO_TELEMETRY=1

exec jcode run --no-update --provider openai-compatible --model hindsight-e2e-stub "$@"
