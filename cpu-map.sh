#!/bin/bash

set -uo pipefail

die() { echo "ERROR: $1" >&2; exit 1; }

# Check arguments
[[ -z "${1:-}" ]] && { echo "Usage: $0 <ALIAS> [LOAD_DURATION]"; echo "  ALIAS: OTT4, OMM0, trade0490, etc."; echo "  LOAD_DURATION: seconds to measure current load (default: 5)"; exit 1; }

ALIAS=$(echo "$1" | tr '[:upper:]' '[:lower:]')
HOST="${ALIAS}.qb.loc"
LOAD_DURATION="${2:-5}"


# Test SSH connection
REAL_HOSTNAME=$(ssh -o BatchMode=yes -o ConnectTimeout=5 "$HOST" "hostname 2>/dev/null" 2>/dev/null | tr -d '\r\n')
[ -z "$REAL_HOSTNAME" ] && die "Cannot connect to $HOST"

HOST_SHORT=$(echo "$REAL_HOSTNAME" | sed 's/\.qb\.loc$//' | sed 's/\..*$//')

# Get passwords
read -s -p "Sudo password for $HOST: " SUDO_PASS
echo "" >&2


# Execute remote collection
ssh -T "$HOST" "SUDO_PASS='$SUDO_PASS' LOAD_DURATION='$LOAD_DURATION' bash -s" << 'REMOTE_SCRIPT'

# Validate sudo
echo "$SUDO_PASS" | sudo -S -v 2>/dev/null || { echo "ERROR: Invalid sudo password" >&2; exit 1; }

HOSTNAME_SHORT=$(hostname -s)

echo "@@HFT_CPU_MAP_V4@@"
echo "HOST:${HOSTNAME_SHORT}"
echo "DATE:$(date -Iseconds)"

# ============================================================================
# LSCPU SECTION - Detailed topology information
# ============================================================================
echo "@@LSCPU@@"
# Try lscpu -e with explicit CACHE column first
if lscpu -e=CPU,NODE,SOCKET,CORE,CACHE,ONLINE >/dev/null 2>&1; then
    lscpu -e=CPU,NODE,SOCKET,CORE,CACHE,ONLINE | grep -v '^CPU' | grep yes | awk '{n=split($5,a,":"); print $1","$2","$3","$4","a[n]}'
elif lscpu -e >/dev/null 2>&1; then
    # Fallback to default -e output
    lscpu -e | grep -v '^CPU' | grep yes | awk '{n=split($5,a,":"); print $1","$2","$3","$4","a[n]}'
else
    # Fallback to -p
    lscpu -p=CPU,NODE,SOCKET,CORE,L3,ONLINE 2>/dev/null | grep -v '^#' | head -256
fi

# ============================================================================
# NUMA SECTION - NUMA node information
# ============================================================================
echo "@@NUMA@@"
if command -v numactl &>/dev/null; then
    numactl -H 2>/dev/null | grep -E '^node [0-9]+ (cpus|size):'
else
    for node_dir in /sys/devices/system/node/node[0-9]*; do
        [ -d "$node_dir" ] || continue
        node=$(basename "$node_dir" | sed 's/node//')
        cpulist=$(cat "$node_dir/cpulist" 2>/dev/null)
        echo "node $node cpus: $cpulist"
        [ -f "$node_dir/meminfo" ] && echo "node $node size: $(awk '/MemTotal:/ {printf "%.0f MB\n", $2/1024}' "$node_dir/meminfo")"
    done
fi

# ============================================================================
# ISOLATED SECTION - Isolated CPUs
# ============================================================================
echo "@@ISOLATED@@"
cat /sys/devices/system/cpu/isolated 2>/dev/null || echo "none"

# ============================================================================
# NETWORK SECTION - Network interfaces with NUMA node
# ============================================================================
echo "@@NETWORK@@"
for iface in $(ls /sys/class/net/ 2>/dev/null | grep -E '^(eth|ens|enp|eno|ena|eni|net|hit)[0-9]'); do
    # Skip virtual interfaces
    [ -f "/sys/class/net/$iface/iflink" ] || continue
    
    # Get NUMA node
    numa=$(cat /sys/class/net/$iface/device/numa_node 2>/dev/null || echo "-1")
    [ "$numa" = "-1" ] && numa="0"
    
    # Get driver
    driver=$(basename $(readlink /sys/class/net/$iface/device/driver 2>/dev/null) 2>/dev/null || echo "?")
    
    # Collect IRQ affinity for this interface
    irqs=""
    for irq_dir in /proc/irq/*; do
        irq=$(basename "$irq_dir")
        [[ "$irq" =~ ^[0-9]+$ ]] || continue
        if grep -q "$iface" "$irq_dir"/* 2>/dev/null; then
            aff=$(cat "$irq_dir/smp_affinity_list" 2>/dev/null)
            [ -n "$aff" ] && irqs+="${irq}:${aff},"
        fi
    done
    echo "IF:$iface|NUMA:$numa|DRV:$driver|IRQ:${irqs%,}"
done

# ============================================================================
# BENDER SECTION - Full Bender configuration
# ============================================================================
echo "@@BENDER@@"
if command -v bender-cpuinfo &>/dev/null; then
    # Try to get full config first
    if [ -f /etc/bender/cpus.conf ]; then
        sudo -n cat /etc/bender/cpus.conf 2>/dev/null || \
        sudo -n bender-cpuinfo 2>/dev/null
    else
        # Fallback to bender-cpuinfo
        sudo -n bender-cpuinfo 2>/dev/null
    fi
else
    # Try to find Bender config in common locations
    for conf_path in /etc/bender/cpus.conf /opt/bender/cpus.conf /usr/local/bender/cpus.conf; do
        if [ -f "$conf_path" ]; then
            sudo -n cat "$conf_path" 2>/dev/null
            break
        fi
    done || echo "N/A"
fi

REMOTE_SCRIPT