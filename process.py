# -*- coding: utf-8 -*-
"""
process.py —— 数据管道（全项目唯一的数据处理脚本）

它只做一件事：把 data/fake_charging.csv 加工成网页唯一的数据源 data.json。

处理流程：
  1. 读 CSV：先试 UTF-8，读不出来就自动换 GBK / GB18030，保证 Excel 导出的文件也能读；
  2. 清洗：丢掉空行、丢掉关键列（日期/时间/场站/充电量/订单数）有缺失的行；
  3. 统计：按"小时 × 场站"分组求和，再算出各场站总量、忙闲度、单小时容量；
  4. 碳数据：减排量 = 总充电量 × 0.5kg，等效种树 = 减排量 ÷ 18kg；
  5. 输出 data.json（UTF-8，带缩进，方便你直接用记事本看）。

运行方式：在项目根目录执行  python process.py
"""
import csv
import json
import os
import sys
import datetime
from collections import defaultdict

# ---------------------------------------------------------------- 路径与常量
# 用脚本所在目录作为"项目根目录"，这样在任何位置执行 python process.py 都不会找错文件
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CSV_PATH = os.path.join(BASE_DIR, "data", "fake_charging.csv")
JSON_PATH = os.path.join(BASE_DIR, "data.json")

# 尝试的编码顺序：utf-8-sig 能吃掉 Excel 的 BOM，gbk/gb18030 兼容中文 Windows
ENCODINGS = ["utf-8-sig", "gbk", "utf-8", "gb18030", "big5", "latin-1"]

# CSV 必须包含的列，缺一列就直接报错，避免"静默错误"
REQUIRED_COLUMNS = ["日期", "时间", "场站", "充电量kWh", "订单数"]

# 周一 ~ 周日的名字（Python 里 weekday() 返回 0=周一 ... 6=周日）
WEEKDAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]

# 碳排放系数：1 度电（1 kWh）约减少 0.5kg 二氧化碳
CARBON_FACTOR = 0.5
# 一棵树一年大约吸收 18kg 二氧化碳
TREE_FACTOR = 18


def read_csv(path):
    """读取 CSV 文本：自动尝试多种编码，全部失败才抛错。返回 (文本, 实际使用的编码)。"""
    if not os.path.exists(path):
        raise FileNotFoundError("找不到数据文件：%s\n请先生成 data/fake_charging.csv" % path)

    for enc in ENCODINGS:
        try:
            with open(path, "r", encoding=enc, newline="") as f:
                return f.read(), enc
        except UnicodeDecodeError:
            continue  # 这个编码读不通，换下一个
    raise ValueError("已尝试 %s，仍然无法解码 CSV" % ENCODINGS)


def parse_hour(raw):
    """把"时间"列转成 0-23 的整数。兼容 8 / 08 / 8:00 / 18:30 这几种写法。"""
    text = str(raw).strip()
    if not text:
        return None
    # 去掉"时""点"这类中文后缀，再取冒号前面的部分
    text = text.replace("时", ":").replace("点", ":")
    head = text.split(":")[0].strip()
    try:
        hour = int(float(head))
    except ValueError:
        return None
    if 0 <= hour <= 23:
        return hour
    return None


def to_float(raw):
    """把充电量转成浮点数，空值或非法值返回 None。"""
    text = str(raw).strip().replace("，", "").replace(",", "")
    if text == "":
        return None
    try:
        return float(text)
    except ValueError:
        return None


def to_int(raw):
    """把订单数转成整数（允许 "5"、"5.0" 这类写法）。"""
    value = to_float(raw)
    if value is None:
        return None
    return int(round(value))


def load_records(path):
    """读取并清洗 CSV，返回（有效记录列表, 使用的编码, 原始数据行数, 被丢弃的行数）。"""
    text, used_encoding = read_csv(path)
    reader = csv.DictReader(text.splitlines())

    fieldnames = [name.strip() for name in (reader.fieldnames or [])]
    missing = [col for col in REQUIRED_COLUMNS if col not in fieldnames]
    if missing:
        raise ValueError("CSV 缺少必要的列：%s\n实际列名：%s" % ("、".join(missing), fieldnames))
    reader.fieldnames = fieldnames  # 列名去除首尾空格后再用

    records = []
    total_rows = 0
    dropped = 0
    for row in reader:
        total_rows += 1
        # 整行为空（Excel 末尾常有的空行）直接跳过
        if not any((value or "").strip() for value in row.values() if isinstance(value, str)):
            dropped += 1
            continue

        date_text = (row.get("日期") or "").strip()
        station = (row.get("场站") or "").strip()
        hour = parse_hour(row.get("时间"))
        kwh = to_float(row.get("充电量kWh"))
        orders = to_int(row.get("订单数"))

        # 关键字段有任何一个缺失/非法，就当作脏数据丢掉
        if not date_text or not station or hour is None or kwh is None or orders is None:
            dropped += 1
            continue

        # 解析日期，拿不到星期几的记录也丢掉（周几选择器需要它）
        try:
            day = datetime.datetime.strptime(date_text[:10], "%Y-%m-%d").date()
        except ValueError:
            dropped += 1
            continue

        records.append({
            "date": day,
            "hour": hour,
            "station": station,
            "kwh": kwh,
            "orders": orders,
        })

    return records, used_encoding, total_rows, dropped


def build_data(records, meta_extra):
    """把清洗后的记录聚合成 data.json 需要的结构。"""
    stations = sorted({r["station"] for r in records})
    days = {r["date"] for r in records}
    day_count = len(days)

    # 统计容器：defaultdict(dict) 可以少写很多 if 判断
    station_kwh = defaultdict(float)          # 每个站的总充电量
    station_orders = defaultdict(int)         # 每个站的总订单数
    hour_orders = defaultdict(lambda: defaultdict(float))   # 小时 -> 站 -> 订单数合计
    hour_kwh = defaultdict(lambda: defaultdict(float))      # 小时 -> 站 -> 充电量合计
    # 周几 -> 小时 -> 站 -> 订单数合计（给"预约推荐页"的周几下拉框用）
    weekday_hour_orders = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))

    # 每个"周几"在数据里出现了多少天，用来求平均（例如 11 月有 5 个周五）
    weekday_day_count = defaultdict(int)
    for weekday in range(7):
        weekday_day_count[weekday] = len({r["date"] for r in records if r["date"].weekday() == weekday})

    for r in records:
        station = r["station"]
        hour = str(r["hour"])
        weekday = WEEKDAY_NAMES[r["date"].weekday()]

        # 1) 场站总量
        station_kwh[station] += r["kwh"]
        station_orders[station] += r["orders"]

        # 2) 按"小时 × 场站"分组求和
        hour_orders[hour][station] += r["orders"]
        hour_kwh[hour][station] += r["kwh"]

        # 3) 按"周几 × 小时 × 场站"分组求和
        weekday_hour_orders[weekday][hour][station] += r["orders"]

    # 场站顺序按"总充电量从高到低"排列，让大屏上最热的站排第一
    stations = sorted(stations, key=lambda name: station_kwh[name], reverse=True)

    # ---------------- 场站总量 + 忙闲度 ----------------
    max_orders = max(station_orders.values()) if station_orders else 1
    overview = {}
    for station in stations:
        overview[station] = {
            "充电量": round(station_kwh[station], 1),
            "订单数": station_orders[station],
            # 忙闲度 = 该站订单数 ÷ 三站中最大订单数（1.0 = 最忙的站）
            "忙闲度": round(station_orders[station] / max_orders, 2),
        }

    # ---------------- 24 小时平均（跨 30 天取平均，大屏看起来才是"典型一天"） ----------------
    hourly = {}
    hourly_kwh = {}
    for hour in range(24):
        hour_key = str(hour)
        hourly[hour_key] = {}
        hourly_kwh[hour_key] = {}
        for station in stations:
            hourly[hour_key][station] = round(hour_orders[hour_key][station] / day_count, 1)
            hourly_kwh[hour_key][station] = round(hour_kwh[hour_key][station] / day_count, 1)

    # ---------------- 每个站"单小时最高订单数" ----------------
    # 这是该站自己的峰值，用来描述"这个站自己最忙的时候有多忙"
    capacity = {}
    for station in stations:
        peak = max(hour_orders[str(h)][station] for h in range(24)) / day_count
        capacity[station] = round(peak, 1) if peak > 0 else 1.0

    # ---------------- 全网单小时最高订单数（占用率的统一分母） ----------------
    # 为什么要有这个"全网"值？
    #   如果拿每个站自己的峰值当分母，那三个站在同一时刻都会算成 ~100%，
    #   大屏上就永远是"三站全红"，看不出谁忙谁闲。
    #   统一分母之后，占用率才能横向比较：100% = 全网最忙的那一个小时。
    capacity_global = round(max(capacity.values()), 1) if capacity else 1.0

    # ---------------- 周几 × 小时 的平均订单数 ----------------
    weekday_hourly = {}
    for index, name in enumerate(WEEKDAY_NAMES):
        if weekday_day_count[index] == 0:
            continue  # 这个月没有这一天（比如只给了 3 天数据）
        weekday_hourly[name] = {}
        for hour in range(24):
            hour_key = str(hour)
            weekday_hourly[name][hour_key] = {}
            for station in stations:
                weekday_hourly[name][hour_key][station] = round(
                    weekday_hour_orders[name][hour_key][station] / weekday_day_count[index], 1
                )

    # ---------------- 碳数据 ----------------
    total_kwh = sum(station_kwh.values())
    total_carbon = total_kwh * CARBON_FACTOR          # 减排 kg
    carbon = {
        "总充电量": round(total_kwh, 1),
        "减排kg": round(total_carbon, 1),
        "等效种树": round(total_carbon / TREE_FACTOR, 1),
    }

    # ---------------- 组装最终结构 ----------------
    data = {
        "stations": stations,          # 场站名单
        "overview": overview,          # 各站读数量 + 忙闲度
        "hourly": hourly,              # 小时 -> 站 -> 平均订单数
        "carbon": carbon,              # 碳账本用
        "hourlyKwh": hourly_kwh,       # 小时 -> 站 -> 平均充电量（柱状图用）
        "capacity": capacity,          # 各站单小时最高订单数（描述"这个站自己最忙时有多忙"）
        "capacityGlobal": capacity_global,  # 全网单小时最高订单数（占用率的统一分母）
        "weekdayHourly": weekday_hourly,  # 周几 -> 小时 -> 站 -> 平均订单数
        "meta": dict(
            {
                "生成时间": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "数据文件": os.path.relpath(CSV_PATH, BASE_DIR).replace("\\", "/"),
                "记录数": len(records),
                "天数": day_count,
                "场站数": len(stations),
                "日期范围": "%s ~ %s" % (min(days).isoformat(), max(days).isoformat()),
                "说明": "hourly/hourlyKwh 为跨天平均的典型一天；capacity 为各站单小时最高订单数，capacityGlobal 为全网单小时最高订单数（占用率分母）；碳系数 0.5kg/度，单树 18kg/年",
            },
            **meta_extra
        ),
    }
    return data


def main():
    # 让 Windows 控制台也能正常打印中文（避免 GBK 编码报错）
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    print("=" * 60)
    print("绿能雷达 · 数据管道开始运行")
    print("=" * 60)
    print("读取文件：%s" % CSV_PATH)

    records, used_encoding, total_rows, dropped = load_records(CSV_PATH)
    if not records:
        raise SystemExit("清洗后没有任何有效数据，请检查 CSV 内容")

    print("文件编码：%s" % used_encoding)
    print("原始行数：%d，剔除空值/脏数据：%d，有效记录：%d" % (total_rows, dropped, len(records)))

    data = build_data(records, {"编码": used_encoding, "剔除行数": dropped})

    # 写出 data.json：ensure_ascii=False 让中文原样保存，缩进 2 空格方便阅读
    with open(JSON_PATH, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print("-" * 60)
    print("场站：%s" % "、".join(data["stations"]))
    for station, info in data["overview"].items():
        print("  %s：充电量 %.1f 度，订单 %d 单，忙闲度 %.2f"
              % (station, info["充电量"], info["订单数"], info["忙闲度"]))
    print("碳数据：总充电量 %.1f 度，减排 %.1f kg，等效种树 %.1f 棵"
          % (data["carbon"]["总充电量"], data["carbon"]["减排kg"], data["carbon"]["等效种树"]))
    print("-" * 60)
    print("已写出：%s" % JSON_PATH)
    print("以下是 data.json 的前 20 行：")
    print("-" * 60)

    with open(JSON_PATH, "r", encoding="utf-8") as f:
        for i, line in enumerate(f):
            if i >= 20:
                break
            print(line.rstrip("\n"))
    print("-" * 60)
    print("完成！")


if __name__ == "__main__":
    main()
