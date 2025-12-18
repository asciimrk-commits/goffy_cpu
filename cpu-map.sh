#!/bin/bash
set -uo pipefail

die() { echo "ОШИБКА: $1" >&2; exit 1; }

VM_PASS_ENC="U2FsdGVkX18pusdjY9ZCJpbzv8gu/WWVeHuuJImbTMNGA19Ty7BBJQDWFmwoQGkb"  # ВСТАВЬ СЮДА результат команды выше

decode_pass() {
    echo "$1" | openssl enc -aes-256-cbc -d -a -pass pass:"nNXVqr77Qv2O" 2>/dev/null
}

usage() {
    echo "Использование: $0 <ALIAS>"
    echo "  ALIAS: OTT4, OMM0, trade0490, и т.д."
    exit 1
}

[[ -z "${1:-}" ]] && usage

ALIAS=$(echo "$1" | tr '[:upper:]' '[:lower:]')
HOST="${ALIAS}.qb.loc"
VM_URL="https://vminsert.qb.loc:8427/api/v1/query"
VM_USER="desk"

REAL_HOSTNAME=$(ssh -o BatchMode=yes -o ConnectTimeout=5 "$HOST" "hostname 2>/dev/null" 2>/dev/null | tr -d '\r\n')
[ -z "$REAL_HOSTNAME" ] && die "Не могу подключиться к $HOST"

HOST_SHORT=$(echo "$REAL_HOSTNAME" | sed 's/\.qb\.loc$//' | sed 's/\..*$//')

read -s -p "Sudo пароль для $HOST: " SUDO_PASS
echo "" >&2

if [ -n "$VM_PASS_ENC" ]; then
    VM_PASS=$(decode_pass "$VM_PASS_ENC")
    [ -z "$VM_PASS" ] && die "Не могу расшифровать пароль VM"
else
    read -s -p "Пароль VM (desk): " VM_PASS
    echo "" >&2
fi

ssh -T "$HOST" "SUDO_PASS='$SUDO_PASS' bash -s" << 'REMOTE_SCRIPT'

echo "$SUDO_PASS" | sudo -S -v 2>/dev/null || { echo "ОШИБКА: Неверный sudo пароль" >&2; exit 1; }

HOSTNAME_SHORT=$(hostname -s)

echo "@@HFT_CPU_MAP_V5@@"
echo "HOST:${HOSTNAME_SHORT}"
echo "DATE:$(date -Iseconds)"

echo "@@LSCPU@@"
# Try lscpu -e with explicit CACHE column first
if lscpu -e=CPU,NODE,SOCKET,CORE,CACHE >/dev/null 2>&1; then
    lscpu -e=CPU,NODE,SOCKET,CORE,CACHE | grep -v '^CPU' | awk '{n=split($5,a,":"); print $1","$2","$3","$4","a[n]}'
elif lscpu -e >/dev/null 2>&1; then
    # Fallback to default -e output, assuming standard columns
    lscpu -e | grep -v '^CPU' | awk '{n=split($5,a,":"); print $1","$2","$3","$4","a[n]}'
else
    # Fallback to -p
    lscpu -p=CPU,NODE,SOCKET,CORE,L3 2>/dev/null | grep -v '^#' | head -256
fi

# If previous commands produced nothing, try numactl fallback
if [ $? -ne 0 ]; then
    if command -v numactl &>/dev/null; then
        numactl -H 2>/dev/null | grep "^node .* cpus:" | while read -r line; do
            node=$(echo "$line" | awk '{print $2}')
            cpus=$(echo "$line" | sed 's/.*cpus: //')
            for cpu in $cpus; do
                echo "$cpu,$node"
            done
        done | while read -r mapping; do
            cpu="${mapping%,*}"
            node="${mapping#*,}"
            socket=$((node / 2))
            core="$cpu"
            l3="$node"
            echo "$cpu,$node,$socket,$core,$l3"
        done | sort -t',' -k1 -n
    else
        for node_dir in /sys/devices/system/node/node[0-9]*; do
            [ -d "$node_dir" ] || continue
            node=$(basename "$node_dir" | sed 's/node//')
            cpulist=$(cat "$node_dir/cpulist" 2>/dev/null)
            echo "$cpulist" | tr ',' '\n' | while read -r range; do
                if [[ "$range" == *-* ]]; then
                    start="${range%-*}"
                    end="${range#*-}"
                    for ((cpu=start; cpu<=end; cpu++)); do
                        echo "$cpu,$node,0,$cpu,$node"
                    done
                else
                    echo "$range,$node,0,$range,$node"
                fi
            done
        done | sort -t',' -k1 -n
    fi
fi

echo "@@NUMA@@"
if command -v numactl &>/dev/null; then
    numactl -H 2>/dev/null | grep -E '^node [0-9]+ (cpus|size):'
else
    for node_dir in /sys/devices/system/node/node[0-9]*; do
        [ -d "$node_dir" ] || continue
        node=$(basename "$node_dir" | sed 's/node//')
        cpulist=$(cat "$node_dir/cpulist" 2>/dev/null)
        echo "node $node cpus: $cpulist"
    done
fi

echo "@@ISOLATED@@"
cat /sys/devices/system/cpu/isolated 2>/dev/null || echo "none"

echo "@@NETWORK@@"
for iface in $(ls /sys/class/net/ 2>/dev/null | grep -E '^(eth|ens|enp|eno|ena|eni|net)[0-9]'); do
    numa=$(cat /sys/class/net/$iface/device/numa_node 2>/dev/null || echo "0")
    [ "$numa" = "-1" ] && numa="0"
    driver=$(basename $(readlink /sys/class/net/$iface/device/driver 2>/dev/null) 2>/dev/null || echo "?")
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

echo "@@BENDER@@"
if command -v bender-cpuinfo &>/dev/null; then
    sudo -n bender-cpuinfo 2>/dev/null | sed -n '/Cpus overview:/,/^$/p' | grep "^{'cpu_id':" | tr -d "'"
else
    echo "N/A"
fi

REMOTE_SCRIPT

QUERY="avg_over_time((100 - cpu_usage_idle{host=\"${HOST_SHORT}.qb.loc\", cpu!=\"cpu-total\"})[30d:])"

LOAD_DATA=$(curl -s -G "$VM_URL" \
    --data-urlencode "query=${QUERY}" \
    -u "${VM_USER}:${VM_PASS}" \
    --insecure 2>/dev/null)

if [ $? -eq 0 ] && echo "$LOAD_DATA" | jq -e '.status == "success"' >/dev/null 2>&1; then
    echo "@@LOAD_AVG_30D@@"
    echo "$LOAD_DATA" | jq -r '.data.result[] |
        .metric.cpu as $cpu |
        .value[1] as $val |
        "\($cpu):\($val | tonumber | . * 100 | round / 100)"' | \
    sed 's/cpu-//' | \
    sort -t':' -k1 -n
    echo "@@END_LOAD@@"
else
    echo "@@LOAD_AVG_30D@@"
    echo "ОШИБКА: Не удалось получить данные из VictoriaMetrics" >&2
    echo "@@END_LOAD@@"
fi
