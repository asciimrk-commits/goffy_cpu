#!/usr/bin/env python3
# ansible managed #
try:
    import re
    import subprocess
    import psutil
    import lxml.etree as ET
    import argparse
    from argparse import RawTextHelpFormatter
    import json
    import os
    from typing import Optional, List, Dict
    import traceback
    import pprint

    import asyncio
    import aiohttp
    import socket

    from aiohttp import ClientTimeout
    from tabulate import tabulate
    import itertools
except ImportError as err:
    print(f"Error: {str(err)}".replace('\'', ''))
    exit(1)


class CpuInfo:
    def __init__(self, id_cpu: int):
        self.cpu_id: int = id_cpu
        self.isolated: bool = False
        self.net_cpu: Optional[list[str]] = []
        self.TrashCPU: Optional[list] = []
        self.AllRobotsThCPU: Optional[list] = []
        self.AllRobotsThCPU: Optional[list] = []
        self.RemoteFormulaCPU: Optional[list] = []
        self.GatewaysDefault: Optional[list] = []
        self.RobotsDefault: Optional[list] = []
        self.RobotsDefault2: Optional[list] = []
        self.Formula: Optional[list] = []
        self.FormulaListDefault: Optional[list] = []
        self.UdpSendCores: Optional[list] = []
        self.UdpReceiveCores: Optional[list] = []
        self.ClickHouseCores: Optional[list] = []
        self.Kafka: Optional[list] = []
        self.GlassNode: Optional[list] = []
        self.DumperCPU: Optional[list] = []
        # It is parameter in BenderServer.xml not kernel isolcpu
        self.Isolated: Optional[list] = []
        self.ServicesCPU: Optional[list] = []
        self.GatewaysOTC: Optional[list] = []
        self.RobotsNode1: Optional[list] = []
        self.RobotsNode2: Optional[list] = []

    def cpu_usage(self) -> List[str]:
        for parameter, value in self.__dict__.items():
            if parameter not in ('cpu_id', 'isolated'):
                yield parameter

    def get(self, attr_name):
        return getattr(self, attr_name)

    def update_attribute(self, attr_name, attr_value):
        if attr_name not in ('cpu_id', 'isolated'):
            v = getattr(self, attr_name)
            if v:
                v.append(attr_value)
                setattr(self, attr_name, v)
            else:
                setattr(self, attr_name, [attr_value])
        else:
            raise Exception(f"update_attribute cant be used for {attr_name}")

    def human_show(self) -> dict:
        output = {}
        for parameter, value in self.__dict__.items():
            if parameter == 'cpu_id' or value:
                output[parameter] = value
        return output

    def zabbix_macros_view(self) -> dict:
        output = {}
        parameters_combined = []
        for parameter, value in self.__dict__.items():
            if value:
                if parameter == 'cpu_id':
                    output['{#CPU.ID}'] = value
                elif parameter not in ('isolated', 'net_cpu'):
                    if isinstance(value, list) and not isinstance(value, str):
                        value = str(','.join(value))
                        parameters_combined.append(f"{parameter}:{value}")
                    else:
                        parameters_combined.append(f"{parameter}:{value}")
                    output['{#CPU.USAGE}'] = ";".join(parameters_combined)
        return output

    def check_free_bender_cpu(self) -> bool:
        for parameter, value in self.__dict__.items():
            if value and parameter not in ['isolated', 'cpu_id', 'net_cpu']:
                return False
        return True

# TODO: skip this
def check_group(groups: list) -> bool:
    try:
        if get_cmdb_primery_gr() in groups:
            return True
        else:
            return False
    except:
        return False


def get_cmdb_primery_gr():
    with open('/etc/cmdb/cmdb_info.json') as f:
        cmdb_data = json.load(f)
    return cmdb_data.get('cmdb_info').get('primary_group').lower()


def numa_network(interfaces: list) -> dict:
    """
    /sys/class/net/hit1/device/local_cpulist
    """
    numad_info = {}
    for interface in interfaces:
        path = f'/sys/class/net/{interface}/device/local_cpulist'
        if os.path.isfile(path):
            with open(path) as f:
                data = f.read().replace('\n', '')
            numad_info[interface] = data
    return numad_info


def sorted_dict_by_key(data: dict) -> dict:
    keys = list(data.keys())
    keys.sort()
    sorted_dict = {i: data[i] for i in keys}
    return sorted_dict


def numa_cpu_info():
    """
    /sys/devices/system/node/node0/cpulist
    """
    r = {}
    # search node files
    node_path = "/sys/devices/system/node"
    for file in os.listdir(node_path):

        if os.path.isdir(f'{node_path}/{file}') and 'node' in file:
            node_cpu_file_path = f'{node_path}/{file}/cpulist'
            if os.path.isfile(node_cpu_file_path):
                with open(node_cpu_file_path) as f:
                    data = f.read()
                    r[file] = cpu_sorted(data)

    return sorted_dict_by_key(r)

def convert_to_ranges(numbers: list) -> str:
    """
    :param numbers: list. Example: [0, 1, 2, 3, 4, 5, 111]
    :return: str. Example: '0,1,2-5,111' or '' if list is empty
    """
    # ai generated
    if len(numbers) == 0:
        return ''
    ranges = []
    start = numbers[0]

    for i in range(1, len(numbers)):
        if numbers[i] != numbers[i - 1] + 1:
            ranges.append((start, numbers[i - 1]))
            start = numbers[i]

    ranges.append((start, numbers[-1]))

    return ",".join([f"{start}-{end}" if start != end else str(start) for start, end in ranges])


def cpu_sorted(data_str: str) -> List[Optional[int]]:
    """
    :param: data_str: supported string as '0,1,2-5,111'"
    :return: list: [0, 1, 2, 3, 4, 5, 111]
    """
    res = []
    for split_data in data_str.replace("\n", "").split(","):
        if '-' in split_data:
            r = []
            start, end = map(int, split_data.split("-"))
            r.extend(range(start, end + 1))
            res = res + r
        else:
            res.append(int(split_data))
    return res


def refactor_parameters(data: str) -> dict:
    res = {}
    for parameter in data.split(" "):
        if parameter:
            if '=' in parameter:
                p = parameter.split("=")
                if p[0] == "isolcpus":
                    if p[1]:
                        res["isolcpus"] = cpu_sorted(p[1])
                    else:
                        res["isolcpus"] = None
                elif p[0] == "cgroup_disable":
                    res[f'cgroup_disable_{p[1]}'] = True
                else:
                    res[p[0]] = p[1]
            else:
                res[parameter] = True
    return res


def find_binstances(bender_type: str = "BenderServer", all_instances: bool = False) -> list:
    binstance_list = list()
    if all_instances:
        bender_home_dir = "/home/bender"
        os.chdir(bender_home_dir)
        all_bender_subdir = [d for d in os.listdir('.') if os.path.isdir(d)]
        if bender_type == 'BenderServer':
            for folder in all_bender_subdir:
                instance_name = re.search('bender2-(.*)', folder)
                if instance_name:
                    if os.access(f'{bender_home_dir}/{folder}', os.R_OK):
                        if os.path.isfile(f'{bender_home_dir}/{folder}/cfg/Runtime.xml'):
                            binstance_list.append(instance_name.group(1).upper())
                    else:
                        raise Exception(f'Cant read path {bender_home_dir}/{folder}')
        binstance_list.sort()
        return binstance_list
    else:
        raw = subprocess.check_output(['/bin/systemctl', 'list-units', f'{bender_type}*'], shell=False,
                                      stderr=subprocess.DEVNULL)
        for line in raw.decode().splitlines():
            service = re.findall(r'%s-(.*?)\.' % bender_type, str(line))
            if service:
                binstance_list.append(service[0].upper())
        binstance_list.sort()
        return binstance_list


def get_grub_parameters() -> Optional[dict]:
    with open('/etc/default/grub') as f:
        data = f.read()
    grub_data = re.findall(r'GRUB_CMDLINE_LINUX=\"(.*?)\"', data)
    if grub_data:
        return refactor_parameters(grub_data[0])


def get_cmdline_parameters() -> Optional[dict]:
    with open('/proc/cmdline') as f:
        cmdline_data = f.read().replace('\n', '')
    if cmdline_data:
        return refactor_parameters(cmdline_data)


def check_parameters(param_dict: dict, req_param_dict: Optional[dict]) -> Optional[str]:
    """
    Check if the given parameters match the required parameters.

    :param param_dict: Dictionary containing the actual parameters.
    :param req_param_dict: Dictionary containing the required parameters. If None, defaults to REQ_PARAM_FOR_GR["default"].
    :return: A string listing invalid parameters if mismatches are found, otherwise None.
    """
    req_parameters = req_param_dict or REQ_PARAM_FOR_GR.get("default", {})
    err_parameters = [key for key in req_parameters if req_parameters[key] != param_dict.get(key)]

    return f"Invalid parameters: {', '.join(err_parameters)}" if err_parameters else None


def get_system_isolated_cpus() -> Optional[list]:
    """
    Reads the list of isolated CPUs from '/sys/devices/system/cpu/isolated'.

    :return: A sorted list of isolated CPU cores if isolated exists, otherwise None.
    :raises OSError: If the file '/sys/devices/system/cpu/isolated' cannot be read.
    """
    with open('/sys/devices/system/cpu/isolated') as f:
        data = f.read().replace('\n', '')
    if data:
        isolated_system_cpu = cpu_sorted(data)
        return isolated_system_cpu


def get_isolated_cpu() -> None:
    sys_isol_cpus = get_system_isolated_cpus()
    if sys_isol_cpus:
        for cpu in CPUS:
            if cpu.cpu_id in get_system_isolated_cpus():
                cpu.isolated = True


def get_all_cpus() -> List[CpuInfo]:
    """
    :return: { 1: CpuInfo, 2: CpuInfo }
    """
    cpus = []
    with open("/sys/devices/system/cpu/online") as f:
        data = f.read()
    for each_cpu in cpu_sorted(data):
        cpus.append(CpuInfo(id_cpu=int(each_cpu)))
    return cpus


def update_cpus(cores_list: list[int|str], upd_param: str, upd_instance: str) -> Optional[list]:
    update_errors = []
    for core in cores_list:
        cpu_for_update = get_cpu_by_id(int(core))
        if cpu_for_update is None:
            update_errors.append(f'{upd_param} cpu {core} doesnt exist')
            continue
        cpu_for_update.update_attribute(upd_param, upd_instance)
    return update_errors


def get_cpu_info_bender(instance: str) -> Optional[str]:
    """
    :param instance: str
    :return: None or error cpu
    """
    # tree = ET.parse(f"Runtime.xml")
    tree = ET.parse(f"/home/bender/bender2-{instance.upper()}/cfg/Runtime.xml")
    '''/home/bender/bender2-{instance.upper()}/cfg/Runtime.xml'''
    root = tree.getroot()
    err_cpu = []
    parameters_list = [
        'AllRobotsThCPU',
        'TrashCPU',
        'RemoteFormulaCPU',
        'DumperCPU'
    ]
    for parameter in parameters_list:
        parameter_xml_obj = root.find(parameter)
        if parameter_xml_obj is None:
            continue
        err_cpu.extend(update_cpus(parameter_xml_obj.get('Cores').split(','), parameter, instance))

    # Search cpu alias
    cpu_aliases = root.findall('CPUAlias')
    for cpu_alias in cpu_aliases:
        err_cpu.extend(update_cpus(cpu_alias.get("Cores").split(','), cpu_alias.get("Name"), instance))

    # search udp send/receive
    for udp_type in ['Send', 'Receive']:
        udp_block_send_cpu_path = root.xpath(f".//Udp/{udp_type}/CPU")
        if len(udp_block_send_cpu_path) == 1:
            udp_errors = update_cpus(udp_block_send_cpu_path[0].get("Cores").split(','),
                                     f"Udp{udp_type}Cores", instance)
            err_cpu.extend(udp_errors)

    # some special params
    special_params = (
        ('.//TSDatabases/TSDB/Threads', 'ClickHouseCores'),
        ('.//DealsStream/Cpu', 'Kafka'),
        ('.//ServicesCPU', 'ServicesCPU')
    )

    for param_path, param_name  in special_params:
        param_info = root.xpath(param_path)
        if len(param_info) == 1:
            err_cpu.extend(update_cpus(param_info[0].get("Cores").split(','), param_name, instance))

    if err_cpu:
        return f'{instance}: {err_cpu}'


def get_cpu_by_id(cid: int) -> CpuInfo:
    for cpu in CPUS:
        if cpu.cpu_id == cid:
            return cpu


def get_instance_info(bs: str) -> dict:
    result_instance_info = {}
    for cpu in CPUS:
        for role in cpu.human_show():
            if type(cpu.human_show()[role]) is list:
                if bs in cpu.human_show()[role]:
                    if result_instance_info.get(role):
                        result_instance_info[role].append(cpu.cpu_id)
                    else:
                        result_instance_info[role] = [cpu.cpu_id]

    return {bs: sorted_dict_by_key(result_instance_info)}


def get_interfaces(only_physical: bool = True, only_up: bool = True) -> list:
    """
    Retrieves a list of network interfaces available on the system.

    :param only_physical: bool, optional. If True, returns only physical interfaces. Defaults to True.
    :param only_up: bool, optional. If True, returns only interfaces that are up. Defaults to True.
    :return: list. A sorted list of network interface names like as ['net0', 'net1'].
    """
    def check_physical(iface: str) -> bool:
        """
        :param iface: Interface name
        :return: True if physical and False if interface is virtual
        """
        if 'virtual' in os.readlink(os.path.join("/sys/class/net/", iface)):
            return False
        else:
            return True

    all_interfaces = []
    for interface, stats in psutil.net_if_stats().items():
        if only_physical and not check_physical(interface):
            continue
        if only_up and not stats.isup:
            continue
        all_interfaces.append(interface)

    return sorted(all_interfaces)


# TODO: not need it, delete this function later
def get_driver_name(interface) -> str:
    """
    Retrieves the driver name of a given network interface.
    check path `/sys/class/net/net0/device/driver`, alternative: `ethtool -i net0 | grep driver`

    :param interface: str. The name of the network interface.
    :return: str. The name of the driver associated with the given interface.
    :raises Exception: If the driver name cannot be retrieved.
    """
    try:
        driver_link = f"/sys/class/net/{interface}/device/driver"
        if os.path.exists(driver_link):
            return os.path.basename(os.path.realpath(driver_link))
    except Exception as e:
        raise Exception(f"Cant get driver name. Err: {e}")


def get_pci_id(interface) -> str:
    """
    Retrieves the PCI ID (bus-info) of a given network interface.
    Check path `/sys/class/net/net0/device` .Alternative: `ethtool -i net0 | grep bus-info`

    :param interface: str. The name of the network interface.
    :return: str. The PCI ID of the given interface.
    :raises Exception: If the PCI ID cannot be retrieved.
    """
    try:
        symlink_path = f"/sys/class/net/{interface}/device"
        real_path = os.path.realpath(symlink_path)
        parts = real_path.split("/")
        return parts[-1]
    except Exception as e:
        raise Exception(f"Cant get id for interface {interface}: {e}")


def get_network_cpu(interfaces: List[str]) -> None:
    """
    Updates information about network CPU usage.

    :param interfaces: list. A list of network interfaces to monitor.
                       Example: ['net0', 'net1']
    :return: None
    """
    with open('/proc/interrupts') as f:
        interrupts_data = f.readlines()
    for interface in interfaces:
        net_cpus = []
        # TODO: check only mlx5_core can be
        if get_driver_name(interface) == 'mlx5_core':
            interface_name = get_pci_id(interface)
        else:
            interface_name = interface
        for line in interrupts_data:
            if interface_name in line:
                with open(f'/proc/irq/{line.split()[0].replace(":", "")}/smp_affinity_list') as f:
                    data = f.read()
                net_cpus = net_cpus + cpu_sorted(data)
        if net_cpus:
            net_cpus_sorted = sorted(set(net_cpus))
            if net_cpus_sorted:
                update_cpus(net_cpus_sorted, 'net_cpu', interface)


def check_isolation_parameters(zabbix: bool = False) -> str:
    if zabbix:
        # don`t check if test group
        if check_group(['trade_qb_test', 'workstation_dev']):
            return "OK"
        # don`t check if not BenderServer
        if len(find_binstances()) == 0:
            return "OK"
    err_check = ""
    grub = get_grub_parameters()
    cmdline = get_cmdline_parameters()
    system = get_system_isolated_cpus()
    bs_cpu_instance_info = get_info_about_cpus(INCLUDE_DEAD_BS)
    if bs_cpu_instance_info.get('instance_info'):
        invalid_cpus = bs_cpu_instance_info.get("cpu_error")
        if invalid_cpus:
            err_check += f'Invalid cpus: {" ".join(invalid_cpus)}; '
    if system != grub.get('isolcpus'):
        err_check += "'Isolated cpu /sys/devices/system/cpu/isolated' not eq '/etc/default/grub'; "
    if system != cmdline.get('isolcpus'):
        err_check += "'Isolated cpu /sys/devices/system/cpu/isolated' not eq '/proc/cmdline'; "
    if not system:
        err_check += "The server does not have isolated cpus; "

    if psutil.cpu_count(logical=True) != psutil.cpu_count(logical=False):
        err_check += "Hyperthreading enable, the logical cpus number is not equal to the physical cpus number; "
    if check_hypertrading():
        err_check += "Hyperthreading enable, look '/sys/devices/system/cpu/smt/active'; "

    req_param_for_check = REQ_PARAM_FOR_GR.get(get_cmdb_primery_gr())

    cmdline_check = check_parameters(cmdline, req_param_for_check)
    if cmdline_check:
        err_check += f'Cmdline {cmdline_check}; '
    grub_check = check_parameters(grub, req_param_for_check)
    if grub_check:
        err_check += f'Grub {grub_check}; '
    if err_check:
        err_check = err_check[:-2]
        if zabbix:
            return f"Error: {err_check}"
        else:
            return err_check.replace('; ', '\n')
    else:
        return "OK"


def get_info_about_cpus(search_all_bs: bool) -> dict:
    instances = find_binstances('BenderServer', search_all_bs)
    res_instances = {}
    cpus_err = []
    for instance in instances:
        cpu_errors = get_cpu_info_bender(instance)
        if cpu_errors:
            cpus_err.append(cpu_errors)
    for instance in instances:
        res_instances.update(get_instance_info(instance))

    return {"instance_info": res_instances, "cpu_error": cpus_err}


def check_hypertrading() -> bool:
    with open('/sys/devices/system/cpu/smt/active') as f:
        data = f.read().replace('\n', '')
    if data == '1':
        return True
    elif data == '0':
        return False
    else:
        raise Exception(f"'/sys/devices/system/cpu/smt/active' - have unsupported value {data}")


def human_view():
    pp = pprint.PrettyPrinter(compact=True)

    # Updated CPUS dict
    get_isolated_cpu()
    # Update network information
    network_interfaces = get_interfaces()
    get_network_cpu(network_interfaces)
    res = get_info_about_cpus(INCLUDE_DEAD_BS)
    # end updated

    system_cpus = []
    free_cpus = []
    print(f'Cpus overview:\n{"_" * 17}')
    for cpu in CPUS:
        if cpu.isolated is False:
            system_cpus.append(cpu.cpu_id)
        else:
            if cpu.check_free_bender_cpu():
                free_cpus.append(cpu.cpu_id)
        print(cpu.human_show())
    print(f'\nInstance overview:\n{"_" * 17}')
    for k, v in res.get("instance_info").items():
        print(f'{k}:')
        pp.pprint(v)
    if res.get("cpu_error"):
        print(f'\nErrors:\n{"_" * 17}')
        for err_cpu in res.get("cpu_error"):
            print(err_cpu)
    print(f'\nOverview:\n{"_" * 17}')
    print(f"Cpu count: {len(CPUS)}")
    print(f"System cpus count: {len(system_cpus)}")
    print(f"System cpus: {convert_to_ranges(system_cpus)}")
    print(f"Unused bender isolated cpus: {convert_to_ranges(free_cpus)}")
    cpu_node_info = numa_cpu_info()
    if cpu_node_info:
        print(f'\nNuma cpu node topology:\n{"_" * 17}')
        for node, node_cpu in cpu_node_info.items():
            print(f'{node}: {convert_to_ranges(node_cpu)}')
    net_view(network_interfaces)


def json_view() -> str:
    result = []
    # Updated CPUS dict
    get_isolated_cpu()
    get_info_about_cpus(INCLUDE_DEAD_BS)
    get_network_cpu(get_interfaces())
    for cpu in CPUS:
        result.append(cpu.__dict__)
    return json.dumps(result, indent=4)

def zabbix_discovery() -> str:
    result = []
    get_isolated_cpu()
    get_info_about_cpus(INCLUDE_DEAD_BS)
    for cpu in CPUS:
        if cpu.isolated is True:
            result.append(cpu.zabbix_macros_view())
    return json.dumps(result)


def telegraf_metrics() -> str:
    result = ''
    # Updated CPUS dict
    get_isolated_cpu()
    get_info_about_cpus(INCLUDE_DEAD_BS)
    get_network_cpu(get_interfaces())
    for cpu in CPUS:
        cpu_id = f"cpu{cpu.cpu_id}"

        for cpu_name in cpu.cpu_usage():
            for instance in cpu.get(cpu_name):
                result += f"bender_cpu_info,instance={instance},cpu={cpu_id},cpu_usage={cpu_name} isolated={int(cpu.isolated)}\n"
    return result

def net_view(net_interfaces: list[str]) -> None:
    interfaces_info = {}
    for cpu in CPUS:
        if cpu.net_cpu:
            for interface in cpu.net_cpu:
                if interfaces_info.get(interface):
                    interfaces_info[interface].append(cpu.cpu_id)
                else:
                    interfaces_info[interface] = [cpu.cpu_id]
    numa_interface_info = numa_network(net_interfaces)
    if interfaces_info:
        print(f'\nNetwork interfaces cpus:\n{"_" * 17}')
        for interface_name, interface_cpu in interfaces_info.items():
            print(f'{interface_name}: {convert_to_ranges(interface_cpu)}')
    if numa_interface_info:
        print(f'\nNuma network interfaces topology information:\n{"_" * 17}')
        for interface_name, topology_info in numa_interface_info.items():
            print(f'{interface_name}: {topology_info}')


def net_info():
    interfaces = get_interfaces()
    get_isolated_cpu()
    get_network_cpu(interfaces)
    system_cpu = []
    for cpu in CPUS:
        if not cpu.isolated:
            system_cpu.append(cpu.cpu_id)
    print(f'Overview:\n{"_" * 17}')
    print(f"Cpu count: {len(CPUS)}")
    print(f"System cpus count: {len(system_cpu)}")
    print(f"System cpus: {convert_to_ranges(system_cpu)}")
    net_view(interfaces)


def get_ip_address() -> list:
    addresses = []
    for interface, addrs in psutil.net_if_addrs().items():
        for addr in addrs:
            if addr.address == '127.0.0.1':
                continue
            if addr.family == socket.AF_INET:
                addresses.append(addr.address)
    return addresses


async def curl_text(url: str, source_ip: str, status_code: int = 200, timeout: float = 1.5) -> dict:
    """
    Sends an HTTP GET request using the specified source IP.

    :param url: The target URL.
    :param source_ip: The source IP address for the request.
    :param status_code: Expected HTTP response status code (default: 200).
    :param timeout: Request timeout in seconds (default: 1.5).
    :return: A dictionary containing:
        - "ip": The source IP address.
        - "public_ip": The response content or an error message.
        - "status": A boolean indicating whether the request was successful.
    """
    status = False
    connector = aiohttp.TCPConnector(local_addr=(source_ip, 0))
    real_timeout = ClientTimeout(total=timeout)
    async with aiohttp.ClientSession(connector=connector, timeout=real_timeout) as session:
        try:
            async with session.get(url) as response:
                if response.status == status_code:
                    curl_result = await response.text()
                    status = True
                else:
                    curl_result = f'HTTP {response.status}'
        except asyncio.TimeoutError:
            curl_result = 'connection timeout'
        except Exception as error:
            curl_result = f'unexpected error: {str(error)}'
        return {"ip": source_ip, "public_ip": curl_result, "status": status}


async def check_asynco_ip(done_event: asyncio.Event, only_connected_ips: bool = True) -> None:
    ips = get_ip_address()
    system_ip = subprocess.run(["ip", "route", "get", "8.8.8.8"], capture_output=True, text=True).stdout.split("src")[1].split()[0]
    system_pub_ip = None
    tasks = [asyncio.create_task(curl_text(url='https://ifconfig.me/ip', source_ip=ip, status_code=200)) for ip in ips]
    view_list = []
    for i in sorted(await asyncio.gather(*tasks), key=lambda d: d['ip']):
        if not only_connected_ips or i.get("status"):
            if not system_pub_ip and i.get("ip") == system_ip:
                system_ip = i.get("ip") + " (system)"
                system_pub_ip = i.get("public_ip")
                continue
            view_list.append([i.get("ip"), i.get("public_ip")])
    view_list.insert(0, [system_ip, system_pub_ip])
    print("\033[K", end="")
    print("\n" + tabulate(view_list, headers=['ip', 'public ip']))
    done_event.set()


async def processing_indicator(done_event: asyncio.Event) -> None:
    spinning_symbols = itertools.cycle(['|', '/', '-', '\\'])
    while not done_event.is_set():
        print("Processing " + next(spinning_symbols), end='\r')
        await asyncio.sleep(0.1)


async def run_tasks_public_ip(only_work_ips: bool) -> None:
    done_event = asyncio.Event()
    await asyncio.gather(
        processing_indicator(done_event),
        check_asynco_ip(done_event, only_work_ips)
    )


def safe_zabbix_msg(msg: str) -> str:
    """
    Convert msg to safe for Zabbix
    Otherwise Zabbix JS parser could fail
    """
    msg = msg.replace('\\', '')
    msg = msg.replace("'", '')
    msg = msg.replace("\"", '')
    msg = msg.replace("\n", ' ')
    msg = msg.replace("\\n", ' ')
    msg = msg.replace("{", ' ')
    msg = msg.replace("}", ' ')
    msg = msg.replace("\t", ' ')
    return msg[:1024]


if __name__ == '__main__':
    choice = ['human', 'zabbix_check', 'check', 'json', 'net', 'ip', 'telegraf_metrics', 'zabbix_discovery']
    parser = argparse.ArgumentParser(
        description='Script by DESK for get information about cpu isolation and map checking',
        formatter_class=RawTextHelpFormatter)
    parser.add_argument(
        "-o", "--output",
        help="Mode working types:\n"
             "human (default) - scope information;\n"
             "zabbix_check - isolation parameters BS check for zabbix;\n"
             "check - isolation parameters BS check with human view, not check active BS;\n"
             "telegraf_metrics - Influx Inline metrics for telegraf;\n"
             "json - about usage BS cpus in json view;\n"
             "net - information about network cpus;\n"
             "ip - information about public IPs;\n"
             "zabbix_discovery - to get BS CPU info to Zabbix Discovery.\n"
             "Example: sudo bender-cpuinfo --output check\n",
        choices=choice, default='human'
    )
    parser.add_argument("-d", "--dead",
                        help="Include not running bender instances. Example: sudo bender-cpuinfo --dead",
                        action="store_true", default=False)
    parser.add_argument("--only_work_ips", help="Show only ips that can connect to the Internet, "
                        "use only with -o ip, example: bender-cpuinfo -o ip --only_work_ips",
                        action="store_true", default=False)
    parser.add_argument("--debug", help="Error traceback", action="store_true", default=False)

    args = parser.parse_args()
    # Global vars
    INCLUDE_DEAD_BS = args.dead
    REQ_PARAM_FOR_GR = {
        "default": {
            "intel_idle.max_cstate": "0",
            "processor.max_cstate": "0",
            "idle": "poll",
            "mitigations": "off",
            "cgroup_disable_cpu": True,
            "cgroup_disable_memory": True,
            "nosmt": True
        },
        "trade_roxana": {
            "intel_idle.max_cstate": "0",
            "processor.max_cstate": "0",
            "idle": "poll",
            "mitigations": "off",
            "nosmt": True
        }

    }

    try:
        CPUS = get_all_cpus()
        if args.output == "human":
            human_view()
        elif args.output == "check":
            print(check_isolation_parameters())
        elif args.output == "zabbix_check":
            print(check_isolation_parameters(zabbix=True))
        elif args.output == "json":
            print(json_view())
        elif args.output == "telegraf_metrics":
            print(telegraf_metrics())
        elif args.output == "net":
            net_info()
        elif args.output == "ip":
            asyncio.run(run_tasks_public_ip(args.only_work_ips))
        elif args.output == "zabbix_discovery":
            print(zabbix_discovery())
    except Exception as err:
        if args.debug:
            print(traceback.format_exc())
        elif args.output == "zabbix_check":
            print(safe_zabbix_msg(str(err)))
        else:
            print(f'Error: {err}')
