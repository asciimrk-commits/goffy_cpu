# HFT CPU Mapper v4.0

Professional CPU topology visualization and optimization tool for BenderServer HFT infrastructure.

![Version](https://img.shields.io/badge/version-4.0-blue)
![License](https://img.shields.io/badge/license-Internal-orange)

## Overview

HFT CPU Mapper provides real-time visualization of CPU core allocation across NUMA nodes, L3 cache regions, and sockets. It helps system administrators optimize trading server performance by ensuring proper placement of latency-critical components.

### Key Features

- **Visual CPU Topology** — Interactive map showing sockets, NUMA nodes, L3 cache regions
- **Role-based Painting** — Assign roles (Gateway, Robot, IRQ, etc.) to cores with drag-and-drop
- **Configuration Compare** — Side-by-side diff of old vs new configurations
- **Auto-Optimization** — Offline AI engine generates recommendations based on BenderServer best practices
- **Export/Import** — Save and load configurations as JSON
- **Validation Engine** — Automatic detection of placement violations

## Quick Start

### 1. Collect Server Data

```bash
# Copy script to your workstation
chmod +x cpu-map.sh

# Run against target server
./cpu-map.sh <host> > output.txt

# Or with custom duration for load measurement
./cpu-map.sh <host> 30 > output.txt
```

### 2. Visualize

1. Open [HFT CPU Mapper](https://asciimrk-commits.github.io/hft-cpu-mapper/)
2. Paste the output into the input field
3. Click **Build Map**

### 3. Optimize

- Use the **Paint Tools** to assign roles to cores
- Switch to **Auto-Optimize** tab for AI-generated recommendations
- Export your configuration as JSON for version control

## Color Scheme

The color palette is designed for semantic clarity:

| Category | Roles | Colors | Description |
|----------|-------|--------|-------------|
| **System** | OS | Grey-blue | Housekeeping, kernel tasks |
| **Network** | IRQ, UDP, Trash | Warm (red, orange, brown) | Network stack, must be on NIC NUMA |
| **Gateway** | Gateways | Yellow | Critical path, needs clean L3 |
| **Logic** | Robots, Pools, AR, RF, Formula, ClickHouse | Cool (teal, blue, purple) | Trading logic |

## Placement Rules

Based on internal BenderServer documentation:

### Network NUMA Node (NIC-attached)

```text
├── IRQ handlers (mandatory)
├── Gateways (clean L3)
├── Trash (must be here)
└── UDP (if traffic > 10k pps)
```

### Logic NUMA Node

```text
├── Diamond tier Robots (clean L3, shared with Gateways ideal)
├── Robots (can be cross-NUMA)
├── AR (AllRobots) — never with Trash!
├── RF (RemoteFormula) — can share with AR or Trash
└── Formula — usually on AR core, rarely dedicated
```

### OS Cores

```text
├── Core 0 + hyperthread
├── Scale based on load average
└── ~20% target utilization
```

## Validation Rules

The tool automatically checks for:

| Rule | Severity | Description |
|------|----------|-------------|
| `network-numa-irq` | Error | IRQ must be on network NUMA |
| `trash-network-numa` | Error | Trash must be on network NUMA |
| `ar-trash-conflict` | Error | AR and Trash cannot share core |
| `gateway-l3-isolation` | Warning | Gateways should have clean L3 |
| `robot-gateway-l3-sharing` | Info | Diamond robots benefit from shared L3 with gateways |
| `os-sizing` | Warning | OS core count based on total cores |

## File Structure

```text
hft-cpu-mapper/
├── index.html          # Main application
├── styles.css          # UI styles (dark theme)
├── app.js              # Core application logic
├── hft-rules.js        # Optimization rules engine
├── cpu-map.sh          # Data collection script
└── README.md           # This file
```

## Data Collection Script

The `cpu-map.sh` script collects:

- CPU topology (lscpu)
- NUMA configuration
- Isolated cores (isolcpus)
- Network interface IRQ affinity
- BenderServer runtime config
- CPU load per core (mpstat)

### Output Format (v4)

```text
@@HFT_CPU_MAP_V4@@
HOST:<host>
DATE:2024-12-13T15:30:00+00:00
@@LSCPU@@
0,0,0,0,0,Y
1,0,0,1,0,Y
...
@@ISOLATED@@
1-95
@@NETWORK@@
IF:eth0|NUMA:0|DRV:ena|IRQ:42:1-2,43:3
@@LOAD@@
0:15.2
1:8.5
...
@@END@@
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `[` | Toggle sidebar |
| `Ctrl+Click` | Erase role from core |

## Compare Mode

1. Export two configurations as JSON
2. Go to **Compare** tab
3. Drop/load old config on left panel
4. Drop/load new config on right panel
5. View diff summary and highlighted changes

### Diff Highlighting

- 🟢 **Added** — Core gained roles in new config
- 🔴 **Removed** — Core lost roles in new config  
- 🟡 **Changed** — Core has different roles

## Auto-Optimization

The offline AI engine analyzes your topology and generates recommendations:

1. Load server data in CPU Mapper tab
2. Switch to **Auto-Optimize** tab
3. Click **Generate Optimization**
4. Review issues, recommendations, and expected outcomes
5. Click **Apply to Map** to apply suggestions

### What It Checks

- NUMA locality for network-dependent tasks
- L3 cache isolation for latency-critical paths
- AR/Trash separation
- OS core sizing based on load
- Cross-NUMA placement warnings

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+

## Development

This is a static site — no build process required.

```bash
# Local development
python -m http.server 8080
# Open http://localhost:8080
```

## Contributing

1. Test changes with demo data (click **Demo** button)
2. Validate against real server output
3. Update rules in `hft-rules.js` if adding new placement logic

## Related Resources

- [Performance Tuning Guide](https://github.com/alexkachanov/performance)

## Changelog

### v4.0 (2024-12)

- Complete UI redesign with semantic color scheme
- Professional compare view with subtle diff highlighting
- Auto-optimization engine with offline AI recommendations
- Optimized data collection script (compact output)
- Validation rules based on BenderServer best practices

### v3.7

- Multi-thread view
- IRQ visualization
- Load bar indicators

### v3.0

- Initial public release
- Basic topology visualization
- Role painting
