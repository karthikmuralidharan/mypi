# Corporate TLS inspection (Cato Networks SASE) replaces the certificate chain
# for some hosts, e.g. mcp.atlassian.com. The macOS keychain trusts the Cato
# root, but Node ships its own CA bundle and does not. Without this, pi's MCP
# client fails with "fetch failed" (SSL: CERTIFICATE_VERIFY_FAILED).
# NODE_EXTRA_CA_CERTS extends Node's bundle; it does not replace it.
# Regenerate the PEM with:
#   security find-certificate -a -c Cato -p /Library/Keychains/System.keychain \
#     > ~/.config/certs/cato-root.pem
if test -f "$HOME/.config/certs/cato-root.pem"
    set -gx NODE_EXTRA_CA_CERTS "$HOME/.config/certs/cato-root.pem"
end
