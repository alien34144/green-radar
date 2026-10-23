# -*- coding: utf-8 -*-
"""
gen_fake_csv.py —— 模拟充电数据生成器（比赛演示用，非真实运营数据）

作用：生成 data/fake_charging.csv，列名固定为：
      日期,时间,场站,充电量kWh,订单数

数据规模：3 个场站 × 24 小时 × 30 天 = 2160 行
生成规则（让数据看起来"像真的"）：
  1. 每个小时有一个"需求权重"：傍晚 18-20 点最高，凌晨 3-5 点最低；
  2. 三个场站有自己的"地段系数"：城南站最热，高新区站最冷清；
  3. 周末白天（9-15 点）商场/公园充电需求略高；
  4. 每个点再叠加 ±12% 的随机波动，避免数据太"完美"。
所有随机数使用固定种子，保证每次生成结果完全一致（可复现）。
"""
import csv
import datetime
import os
import random
import sys

# ---------------------------------------------------------------- 基础配置
# 场站列表：(场站名, 地段系数) —— 系数越大代表这个站越"热门"
STATIONS = [
    ("城南站", 1.15),
    ("城北站", 0.95),
    ("高新区站", 0.82),
]

# 24 小时的需求权重：模拟城市通勤曲线，傍晚最高、深夜最低
HOUR_WEIGHT = [
    0.35, 0.25, 0.18, 0.15, 0.16, 0.22,  # 00:00 - 05:00 深夜，需求很低
    0.35, 0.55, 0.75, 0.80, 0.70, 0.65,  # 06:00 - 11:00 早高峰后回落
    0.60, 0.62, 0.66, 0.70, 0.78, 0.90,  # 12:00 - 17:00 下午缓慢爬升
    1.00, 0.98, 0.92, 0.80, 0.62, 0.45,  # 18:00 - 23:00 晚高峰（最高点 18 点）
]

# 周一到周日的修正系数（周末白天出行多，充电需求略高一点点）
WEEKDAY_FACTOR = {
    0: {"day": 1.00, "weekend": 1.00},  # 周一
    1: {"day": 1.00, "weekend": 1.00},  # 周二
    2: {"day": 1.00, "weekend": 1.00},  # 周三
    3: {"day": 1.00, "weekend": 1.00},  # 周四
    4: {"day": 1.05, "weekend": 1.00},  # 周五晚上略高
    5: {"day": 1.00, "weekend": 1.18},  # 周六
    6: {"day": 1.00, "weekend": 1.18},  # 周日
}

BASE_ORDERS = 4.9   # 基准：参考场站每小时的平均订单数（别乱改，会影响碳账本数字）
START_DATE = datetime.date(2024, 11, 1)  # 数据起始日期（11 月 1 日，共 30 天）
DAYS = 30
KWH_PER_ORDER_MIN = 26.0  # 一笔订单平均充多少度电（下限）
KWH_PER_ORDER_MAX = 36.0  # 一笔订单平均充多少度电（上限）

# 输出文件路径：永远写到本脚本同目录下的 fake_charging.csv
OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fake_charging.csv")


def build_rows():
    """按照需求权重 × 地段系数 × 工作日/周末系数，生成所有行。"""
    random.seed(20241101)  # 固定随机种子 -> 结果可复现
    rows = []
    for day_index in range(DAYS):
        day = START_DATE + datetime.timedelta(days=day_index)
        weekday = day.weekday()  # 0=周一 ... 6=周日
        is_weekend = weekday >= 5

        for hour in range(24):
            # 周末白天（9-15 点）额外加成，其它时段不加
            weekend_bonus = 1.0
            if is_weekend and 9 <= hour <= 15:
                weekend_bonus = WEEKDAY_FACTOR[weekday]["weekend"]
            friday_bonus = WEEKDAY_FACTOR[weekday]["day"] if weekday == 4 and hour >= 18 else 1.0

            for station_name, station_factor in STATIONS:
                # 计算这一格的订单数：基准 × 小时权重 × 地段系数 × 周末/周五系数 × 随机波动
                noise = random.uniform(0.88, 1.12)  # ±12% 的随机波动
                orders = BASE_ORDERS * HOUR_WEIGHT[hour] * station_factor
                orders = orders * weekend_bonus * friday_bonus * noise
                orders = max(0, int(round(orders)))  # 订单数取整数

                # 每笔订单的充电量也做一点随机（26~36 度之间）
                if orders > 0:
                    avg_kwh = random.uniform(KWH_PER_ORDER_MIN, KWH_PER_ORDER_MAX)
                    kwh = round(orders * avg_kwh, 1)
                else:
                    kwh = 0.0

                rows.append({
                    "日期": day.strftime("%Y-%m-%d"),
                    "时间": hour,          # 0-23 的整点小时
                    "场站": station_name,
                    "充电量kWh": kwh,
                    "订单数": orders,
                })
    return rows


def main():
    # 让 Windows 控制台也能正常打印中文
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    rows = build_rows()
    # utf-8-sig：带 BOM 的 UTF-8，用 Excel 直接双击打开不会乱码
    with open(OUT_PATH, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=["日期", "时间", "场站", "充电量kWh", "订单数"])
        writer.writeheader()
        writer.writerows(rows)

    total_kwh = sum(r["充电量kWh"] for r in rows)
    total_orders = sum(r["订单数"] for r in rows)
    print("已生成：%s" % OUT_PATH)
    print("行数：%d（3 站 × 24 小时 × 30 天）" % len(rows))
    print("总充电量：%.1f kWh，总订单数：%d" % (total_kwh, total_orders))
    print("预计减排：%.1f kg，等效种树：%.0f 棵" % (total_kwh * 0.5, total_kwh * 0.5 / 18))


if __name__ == "__main__":
    main()
