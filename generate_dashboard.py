#!/usr/bin/env python3
"""Generate comprehensive HFT Performance Dashboard for Grafana."""

import json

def create_stat_panel(id, title, description, expr, legend, unit, thresholds, x, y, w=4, h=4):
    return {
        "datasource": {"type": "prometheus", "uid": "${datasource}"},
        "description": description,
        "fieldConfig": {
            "defaults": {
                "color": {"mode": "thresholds"},
                "mappings": [],
                "thresholds": {"mode": "absolute", "steps": thresholds},
                "unit": unit
            },
            "overrides": []
        },
        "gridPos": {"h": h, "w": w, "x": x, "y": y},
        "id": id,
        "options": {
            "colorMode": "value",
            "graphMode": "area",
            "justifyMode": "auto",
            "orientation": "auto",
            "reduceOptions": {"calcs": ["mean"], "fields": "", "values": False},
            "showPercentChange": True,
            "textMode": "auto",
            "wideLayout": True
        },
        "pluginVersion": "11.5.2",
        "targets": [{"datasource": {"type": "prometheus", "uid": "${datasource}"}, "expr": expr, "legendFormat": legend, "refId": "A"}],
        "title": title,
        "type": "stat"
    }

def create_timeseries_panel(id, title, description, targets, unit, thresholds, x, y, w=8, h=8):
    return {
        "datasource": {"type": "prometheus", "uid": "${datasource}"},
        "description": description,
        "fieldConfig": {
            "defaults": {
                "color": {"mode": "palette-classic"},
                "custom": {
                    "axisBorderShow": False,"axisCenteredZero": False,"axisColorMode": "text",
                    "axisLabel": "","axisPlacement": "auto","barAlignment": 0,"barWidthFactor": 0.6,
                    "drawStyle": "line","fillOpacity": 10,"gradientMode": "none",
                    "hideFrom": {"legend": False, "tooltip": False, "viz": False},
                    "insertNulls": False,"lineInterpolation": "smooth","lineWidth": 2,"pointSize": 5,
                    "scaleDistribution": {"type": "linear"},"showPoints": "never","spanNulls": False,
                    "stacking": {"group": "A", "mode": "none"},
                    "thresholdsStyle": {"mode": "line"}
                },
                "mappings": [],
                "thresholds": {"mode": "absolute", "steps": thresholds},
                "unit": unit
            },
            "overrides": []
        },
        "gridPos": {"h": h, "w": w, "x": x, "y": y},
        "id": id,
        "options": {
            "legend": {"calcs": ["mean", "max", "lastNotNull"], "displayMode": "table", "placement": "bottom", "showLegend": True, "sortBy": "Max", "sortDesc": True},
            "tooltip": {"hideZeros": False, "mode": "multi", "sort": "desc"}
        },
        "pluginVersion": "11.5.2",
        "targets": targets,
        "title": title,
        "type": "timeseries"
    }

def create_row(id, title, y, collapsed=False):
    return {"collapsed": collapsed, "gridPos": {"h": 1, "w": 24, "x": 0, "y": y}, "id": id, "panels": [], "title": title, "type": "row"}

def target(expr, legend, refId="A"):
    return {"datasource": {"type": "prometheus", "uid": "${datasource}"}, "expr": expr, "legendFormat": legend, "refId": refId}

def green_yellow_red(yellow, red):
    return [{"color": "green", "value": None}, {"color": "yellow", "value": yellow}, {"color": "red", "value": red}]

def main():
    panels = []
    
    # Row 1: KPIs
    panels.append(create_row(100, "KEY PERFORMANCE INDICATORS", 0))
    panels.append(create_stat_panel(1, "P99 Reaction Time", "Primary latency KPI. Lower is better.", 
        'avg(bender_metrics_robot_timings_metrics_reaction_p99{host=~"$host", bs=~"$bs"})', "P99 Reaction", "µs", green_yellow_red(30, 60), 0, 1))
    panels.append(create_stat_panel(2, "P100 Max Spike", "Worst-case latency spike. Critical for risk management.",
        'max(bender_metrics_robot_timings_metrics_cycle_p100{host=~"$host", bs=~"$bs"})', "Max Spike", "µs", green_yellow_red(80, 150), 4, 1))
    panels.append(create_stat_panel(3, "Jitter (P99-P50)", "Latency variance. Lower means more stable system. Target <20us",
        'avg(bender_metrics_robot_timings_metrics_cycle_p99{host=~"$host", bs=~"$bs"} - bender_metrics_robot_timings_metrics_cycle_p50{host=~"$host", bs=~"$bs"})', "Jitter", "µs", green_yellow_red(15, 30), 8, 1))
    panels.append(create_stat_panel(4, "Thread Pool Congestion", "Thread pool contention. 0=normal, >1=CPU starvation",
        'avg(bender_metrics_thread_pool_metrics_congestion{host=~"$host", bs=~"$bs"})', "Congestion", "short", green_yellow_red(0.3, 0.8), 12, 1))
    panels.append(create_stat_panel(5, "Chrony Offset", "Time sync offset. Critical for HFT. Target <1ms",
        'avg(abs(chrony_reference_offset{host=~"$host"}))', "Offset", "s", green_yellow_red(0.0001, 0.001), 16, 1))
    panels.append(create_stat_panel(6, "UDP Errors Rate", "UDP receive/send errors indicating network problems",
        'sum(rate(net_udp_inerrors{host=~"$host"}[5m]) + rate(net_udp_rcvbuferrors{host=~"$host"}[5m]))', "Errors/s", "short", green_yellow_red(1, 10), 20, 1))

    # Row 2: Bender Internal Delays
    panels.append(create_row(200, "BENDER SERVER - INTERNAL EXECUTION DELAYS", 5))
    panels.append(create_timeseries_panel(10, "Platform Reaction Time by BS",
        "Total platform reaction latency breakdown by Bender server instance",
        [target('bender_metrics_internal_exec_delays_platform_reaction_p50{host=~"$host", bs=~"$bs"}', "{{bs}} P50", "A"),
         target('bender_metrics_internal_exec_delays_platform_reaction_p99{host=~"$host", bs=~"$bs"}', "{{bs}} P99", "B"),
         target('bender_metrics_internal_exec_delays_platform_reaction_p100{host=~"$host", bs=~"$bs"}', "{{bs}} P100", "C")],
        "µs", green_yellow_red(30, 60), 0, 6))
    panels.append(create_timeseries_panel(11, "MD to AfterCycle Delay by BS",
        "Market data processing to after-cycle completion delay",
        [target('bender_metrics_internal_exec_delays_md_aftercycle_p50{host=~"$host", bs=~"$bs"}', "{{bs}} P50", "A"),
         target('bender_metrics_internal_exec_delays_md_aftercycle_p99{host=~"$host", bs=~"$bs"}', "{{bs}} P99", "B")],
        "µs", green_yellow_red(20, 50), 8, 6))
    panels.append(create_timeseries_panel(12, "Gateway Path Delays",
        "Gateway wake to send, and post-order to gateway wake delays",
        [target('bender_metrics_internal_exec_delays_gwwoke_gwsend_p99{host=~"$host", bs=~"$bs"}', "{{bs}} GW Woke->Send P99", "A"),
         target('bender_metrics_internal_exec_delays_postorder_gwwoke_p99{host=~"$host", bs=~"$bs"}', "{{bs}} PostOrder->GWWoke P99", "B")],
        "µs", green_yellow_red(10, 30), 16, 6))

    # Row 3: Robot Timing Analysis
    panels.append(create_row(300, "ROBOT TIMING ANALYSIS - PER ROBOT BREAKDOWN", 14))
    panels.append(create_timeseries_panel(20, "Robot Cycle Time P99 by Robot",
        "Full cycle time per robot. Identifies slow robots.",
        [target('bender_metrics_robot_timings_metrics_cycle_p99{host=~"$host", bs=~"$bs", robot=~"$robot"}', "{{robot}}", "A")],
        "µs", green_yellow_red(30, 60), 0, 15, 12))
    panels.append(create_timeseries_panel(21, "Robot Reaction Time by Robot",
        "Reaction time per robot to market data",
        [target('bender_metrics_robot_timings_metrics_reaction_p99{host=~"$host", bs=~"$bs", robot=~"$robot"}', "{{robot}} P99", "A"),
         target('bender_metrics_robot_timings_metrics_reaction_p50{host=~"$host", bs=~"$bs", robot=~"$robot"}', "{{robot}} P50", "B")],
        "µs", green_yellow_red(25, 50), 12, 15, 12))

    # Row 4: Market Data Pipeline
    panels.append(create_row(400, "MARKET DATA PIPELINE - BOOK DELAYS", 23))
    panels.append(create_timeseries_panel(30, "Gateway to Publisher Delay",
        "Time from gateway receive to publisher output",
        [target('bender_metrics_book_delay_gw_to_publisher_p50{host=~"$host", bs=~"$bs"}', "{{bs}} P50", "A"),
         target('bender_metrics_book_delay_gw_to_publisher_p99{host=~"$host", bs=~"$bs"}', "{{bs}} P99", "B")],
        "µs", green_yellow_red(10, 30), 0, 24))
    panels.append(create_timeseries_panel(31, "Publisher to Subscribers Delay",
        "Delay from publish start to all subscribers notified",
        [target('bender_metrics_book_delay_publish_to_subscribers_p99{host=~"$host", bs=~"$bs"}', "{{bs}} P99", "A")],
        "µs", green_yellow_red(5, 15), 8, 24))
    panels.append(create_timeseries_panel(32, "Publisher to Robot Delay",
        "Book delay from publisher to individual robots",
        [target('bender_metrics_publisher_to_robot_book_delay_p99{host=~"$host", bs=~"$bs"}', "{{robot}} P99", "A")],
        "µs", green_yellow_red(10, 25), 16, 24))

    # Row 5: Order Execution Path
    panels.append(create_row(500, "ORDER EXECUTION PATH", 32))
    panels.append(create_timeseries_panel(40, "AfterCycle to Sent Delay",
        "Time from after-cycle decision to order sent",
        [target('bender_metrics_internal_exec_delays_aftercycle_sent_p99{host=~"$host", bs=~"$bs"}', "{{bs}} P99", "A")],
        "µs", green_yellow_red(15, 40), 0, 33))
    panels.append(create_timeseries_panel(41, "Exchange Roundtrip",
        "Full roundtrip time to exchange and back",
        [target('bender_metrics_internal_exec_delays_exchange_roundtrip_p99{host=~"$host", bs=~"$bs"}', "{{bs}} P99", "A"),
         target('bender_metrics_internal_exec_delays_exchange_roundtrip_p50{host=~"$host", bs=~"$bs"}', "{{bs}} P50", "B")],
        "µs", green_yellow_red(100, 300), 8, 33))
    panels.append(create_timeseries_panel(42, "Own Deal Delay",
        "Time from receiving own deal to strategy notification",
        [target('bender_metrics_own_deal_delay_receive_to_strat_publish_p99{host=~"$host", bs=~"$bs"}', "{{robot}} P99", "A"),
         target('bender_metrics_publisher_to_robot_own_deal_delay_p99{host=~"$host", bs=~"$bs"}', "{{robot}} OwnDeal P99", "B")],
        "µs", green_yellow_red(20, 50), 16, 33))

    # Row 6: Queues and Buffers
    panels.append(create_row(600, "QUEUES AND BUFFERS", 41))
    panels.append(create_timeseries_panel(50, "BS Queue Size and Duration",
        "Bender server internal queue metrics. Spikes indicate backpressure.",
        [target('bs_queue_size{host=~"$host"}', "{{bs}} Size", "A"),
         target('bs_queue_duration{host=~"$host"}', "{{bs}} Duration", "B")],
        "short", green_yellow_red(100, 500), 0, 42))
    panels.append(create_timeseries_panel(51, "TCP Queue Metrics",
        "TCP queue size and throughput",
        [target('bs_tcp_queue_size{host=~"$host"}', "{{bs}} Size", "A"),
         target('bs_tcp_queue_mps{host=~"$host"}', "{{bs}} MPS", "B")],
        "short", green_yellow_red(50, 200), 8, 42))
    panels.append(create_timeseries_panel(52, "Thread Pool Robot Wait",
        "Time robots wait for thread pool. High values = CPU contention.",
        [target('bender_metrics_thread_pool_metrics_robot_wait_p99{host=~"$host", bs=~"$bs"}', "{{bs}} P99", "A"),
         target('bender_metrics_thread_pool_metrics_robot_wait_p50{host=~"$host", bs=~"$bs"}', "{{bs}} P50", "B")],
        "µs", green_yellow_red(5, 15), 16, 42))

    # Row 7: Network Statistics
    panels.append(create_row(700, "NETWORK STATISTICS - UDP/TCP HEALTH", 50))
    panels.append(create_timeseries_panel(60, "UDP Errors by Type",
        "UDP receive errors, buffer errors. Non-zero indicates network/buffer issues.",
        [target('rate(net_udp_inerrors{host=~"$host"}[5m])', "{{host}} InErrors", "A"),
         target('rate(net_udp_rcvbuferrors{host=~"$host"}[5m])', "{{host}} RcvBufErrors", "B"),
         target('rate(net_udp_sndbuferrors{host=~"$host"}[5m])', "{{host}} SndBufErrors", "C")],
        "short", green_yellow_red(0.1, 1), 0, 51))
    panels.append(create_timeseries_panel(61, "TCP Retransmits",
        "TCP retransmission rate indicating packet loss",
        [target('rate(nstat_TcpRetransSegs{host=~"$host"}[5m])', "{{host}} Retrans", "A"),
         target('rate(nstat_TcpExtTCPSynRetrans{host=~"$host"}[5m])', "{{host}} SynRetrans", "B")],
        "short", green_yellow_red(1, 10), 8, 51))
    panels.append(create_timeseries_panel(62, "Network Drops",
        "Network interface drops indicating overload",
        [target('rate(net_drop_in{host=~"$host"}[5m])', "{{host}} {{interface}} Drop In", "A"),
         target('rate(net_drop_out{host=~"$host"}[5m])', "{{host}} {{interface}} Drop Out", "B")],
        "short", green_yellow_red(0.1, 1), 16, 51))

    # Row 8: System Resources
    panels.append(create_row(800, "SYSTEM RESOURCES - CPU AND MEMORY BY PROCESS", 59))
    panels.append(create_timeseries_panel(70, "CPU Usage by Process (Top 10)",
        "CPU time per process. Identify CPU-hungry processes.",
        [target('topk(10, sum by (process_name) (rate(procstat_cpu_time_user{host=~"$host"}[1m]) + rate(procstat_cpu_time_system{host=~"$host"}[1m])))', "{{process_name}}", "A")],
        "percent", [{"color": "green", "value": None}], 0, 60, 12))
    panels.append(create_timeseries_panel(71, "Context Switches by Process (Top 10)",
        "Involuntary context switches per process. Spikes indicate scheduling issues.",
        [target('topk(10, sum by (process_name) (rate(procstat_involuntary_context_switches{host=~"$host"}[1m])))', "{{process_name}}", "A")],
        "short", [{"color": "green", "value": None}], 12, 60, 12))
    panels.append(create_timeseries_panel(72, "Memory RSS by Process (Top 10)",
        "Resident memory per process",
        [target('topk(10, sum by (process_name) (procstat_memory_rss{host=~"$host"}))', "{{process_name}}", "A")],
        "bytes", [{"color": "green", "value": None}], 0, 68, 12))
    panels.append(create_timeseries_panel(73, "System Load Average",
        "System load 1/5/15 minute averages",
        [target('system_load1{host=~"$host"}', "{{host}} 1m", "A"),
         target('system_load5{host=~"$host"}', "{{host}} 5m", "B"),
         target('system_load15{host=~"$host"}', "{{host}} 15m", "C")],
        "short", [{"color": "green", "value": None}], 12, 68, 12))

    # Row 9: Time Synchronization
    panels.append(create_row(900, "TIME SYNCHRONIZATION - CHRONY", 76))
    panels.append(create_timeseries_panel(80, "Chrony Reference Offset",
        "Time offset from reference. Critical for HFT - should be <100us",
        [target('chrony_reference_offset{host=~"$host"}', "{{host}}", "A")],
        "s", green_yellow_red(0.0001, 0.001), 0, 77))
    panels.append(create_timeseries_panel(81, "Chrony Reference Deviation",
        "Estimated error bound of time source",
        [target('chrony_reference_deviation{host=~"$host"}', "{{host}}", "A")],
        "s", green_yellow_red(0.0001, 0.001), 8, 77))
    panels.append(create_timeseries_panel(82, "System Time vs Reference",
        "Difference between system time and reference",
        [target('chrony_tracking_system_time{host=~"$host"}', "{{host}}", "A")],
        "s", green_yellow_red(0.0001, 0.001), 16, 77))

    # Row 10: Robot and Gateway State
    panels.append(create_row(1000, "SERVICE STATE - ROBOTS AND GATEWAYS", 85))
    panels.append(create_timeseries_panel(90, "Bender Server State",
        "BS started state. 1=running, 0=stopped",
        [target('bs_state_started{host=~"$host"}', "{{bs}}", "A")],
        "short", [{"color": "green", "value": None}], 0, 86, 6))
    panels.append(create_timeseries_panel(91, "Gateway State",
        "Gateway started state and subscriber count",
        [target('bs_gateway_state_started{host=~"$host"}', "{{bs}} Started", "A"),
         target('bs_gateway_state_md_subscribers{host=~"$host"}', "{{bs}} Subscribers", "B")],
        "short", [{"color": "green", "value": None}], 6, 86, 6))
    panels.append(create_timeseries_panel(92, "Robot Can Trade Flag",
        "Robot trading capability. 1=can trade, 0=restricted",
        [target('bs_robot_state_flag_can_trade{host=~"$host"}', "{{robot}}", "A")],
        "short", [{"color": "green", "value": None}], 12, 86, 6))
    panels.append(create_timeseries_panel(93, "MD Source Weight",
        "Market data source weights for failover monitoring",
        [target('bs_md_source_weight{host=~"$host"}', "{{bs}} {{source}}", "A")],
        "short", [{"color": "green", "value": None}], 18, 86, 6))

    # Template variables
    templating = {
        "list": [
            {"current": {"text": "vm-metrics-cluster", "value": "RDU9pzunz"}, "includeAll": False, "label": "Datasource", "name": "datasource", "options": [], "query": "prometheus", "refresh": 1, "regex": "", "type": "datasource"},
            {"current": {"text": "All", "value": ["$__all"]}, "datasource": {"type": "prometheus", "uid": "${datasource}"}, "definition": "label_values(bender_metrics_robot_timings_metrics_cycle_p99, host)", "includeAll": True, "label": "Host", "multi": True, "name": "host", "options": [], "query": {"query": "label_values(bender_metrics_robot_timings_metrics_cycle_p99, host)", "refId": "A"}, "refresh": 2, "regex": "", "sort": 1, "type": "query"},
            {"current": {"text": "All", "value": ["$__all"]}, "datasource": {"type": "prometheus", "uid": "${datasource}"}, "definition": "label_values(bender_metrics_robot_timings_metrics_cycle_p99, host)", "includeAll": True, "label": "Compare Host", "multi": True, "name": "host_compare", "options": [], "query": {"query": "label_values(bender_metrics_robot_timings_metrics_cycle_p99, host)", "refId": "A"}, "refresh": 2, "regex": "", "sort": 1, "type": "query"},
            {"current": {"text": "All", "value": ["$__all"]}, "datasource": {"type": "prometheus", "uid": "${datasource}"}, "definition": 'label_values(bender_metrics_robot_timings_metrics_cycle_p99{host=~"$host"},bs)', "includeAll": True, "label": "BS", "multi": True, "name": "bs", "options": [], "query": {"qryType": 1, "query": 'label_values(bender_metrics_robot_timings_metrics_cycle_p99{host=~"$host"},bs)', "refId": "A"}, "refresh": 2, "regex": "", "sort": 1, "type": "query"},
            {"current": {"text": "All", "value": ["$__all"]}, "datasource": {"type": "prometheus", "uid": "${datasource}"}, "definition": 'label_values(bender_metrics_robot_timings_metrics_cycle_p50{host=~"$host", bs=~"$bs"}, robot)', "includeAll": True, "label": "Robot", "multi": True, "name": "robot", "options": [], "query": {"qryType": 1, "query": 'label_values(bender_metrics_robot_timings_metrics_cycle_p50{host=~"$host", bs=~"$bs"}, robot)', "refId": "A"}, "refresh": 2, "regex": "", "sort": 1, "type": "query"},
            {"auto": False, "auto_count": 30, "auto_min": "10s", "current": {"text": "1m", "value": "1m"}, "name": "interval", "options": [{"selected": True, "text": "1m", "value": "1m"}, {"selected": False, "text": "5m", "value": "5m"}, {"selected": False, "text": "10m", "value": "10m"}, {"selected": False, "text": "30m", "value": "30m"}, {"selected": False, "text": "1h", "value": "1h"}], "query": "1m,5m,10m,30m,1h", "refresh": 2, "type": "interval"}
        ]
    }

    dashboard = {
        "annotations": {"list": [{"builtIn": 1, "datasource": {"type": "grafana", "uid": "-- Grafana --"}, "enable": True, "hide": True, "iconColor": "rgba(0, 211, 255, 1)", "name": "Annotations & Alerts", "type": "dashboard"}]},
        "description": "Comprehensive HFT Performance Dashboard for Bender Server - Latency, System Resources, Network Health",
        "editable": True,
        "fiscalYearStartMonth": 0,
        "graphTooltip": 1,
        "id": None,
        "links": [],
        "panels": panels,
        "preload": False,
        "refresh": "",
        "schemaVersion": 40,
        "tags": ["hft", "bender", "latency", "performance", "network"],
        "templating": templating,
        "time": {"from": "now-6h", "to": "now"},
        "timepicker": {},
        "timezone": "",
        "title": "Bender HFT Performance Dashboard",
        "uid": "bender-hft-perf-v1",
        "version": 1,
        "weekStart": ""
    }

    with open("/Users/user/work/goffy_cpu/Bender-HFT-Performance-Dashboard.json", "w") as f:
        json.dump(dashboard, f, indent=2)
    
    print("Dashboard generated: Bender-HFT-Performance-Dashboard.json")
    print(f"Total panels: {len([p for p in panels if p['type'] != 'row'])}")
    print(f"Total rows: {len([p for p in panels if p['type'] == 'row'])}")

if __name__ == "__main__":
    main()
