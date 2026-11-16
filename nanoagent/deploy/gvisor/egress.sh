#!/usr/bin/env bash
# Installs the packet filter behind `limits.internet_access` on a Linux execution worker. Idempotent; run with sudo.
#
#   sudo bash deploy/gvisor/egress.sh [subnet]        (default 10.213.0.0/16, `egress.subnet` in the worker config)
#
# A harness with internet access runs on a per-attempt bridge network carved out of the reserved subnet. Docker NATs that
# network to the internet; this filter keeps it public-only:
#   * FORWARD (via DOCKER-USER): traffic from the subnet to any private, shared, loopback, link-local (cloud metadata
#     included), unspecified or multicast address is dropped. Traffic inside the subnet is left to Docker, which isolates
#     the attempt networks from each other and keeps the attempt's own relay (gateway, tool broker, command service)
#     reachable.
#   * INPUT: everything from the subnet to an address of this host is dropped, so no service on the worker host (nor on
#     the bridge gateway) is reachable.
# The attempt networks are IPv4 only, so IPv6 (loopback, ULA fc00::/7, link-local fe80::/10) has no route at all.
set -euo pipefail
subnet="${1:-10.213.0.0/16}"
chain=RUSH-EGRESS
blocked=(0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4)

iptables -N "$chain" 2>/dev/null || true
iptables -F "$chain"
iptables -A "$chain" -d "$subnet" -j RETURN
for range in "${blocked[@]}"; do
  iptables -A "$chain" -d "$range" -j DROP
done
iptables -A "$chain" -j RETURN
# DOCKER-USER is consulted before Docker's own forwarding rules; INPUT sees traffic to the host's own addresses.
iptables -C DOCKER-USER -s "$subnet" -j "$chain" 2>/dev/null || iptables -I DOCKER-USER 1 -s "$subnet" -j "$chain"
iptables -C INPUT -s "$subnet" -j DROP 2>/dev/null || iptables -I INPUT 1 -s "$subnet" -j DROP
