/* =========================================================================
   charts.js —— 全站共用的画图函数 & 数据工具（所有页面都引入这一个文件）

   里面提供 4 类东西：
     1. ChartKit.loadData()      读取 data.json（网页唯一数据源）
     2. ChartKit.occupancy() 等  用原始数据算"占用率 / 忙闲状态 / 预计等待"
     3. ChartKit.createBarChart / createPieChart / createHBarChart  三个 ECharts 图表
     4. ChartKit.resizeAll()     浏览器窗口变化时让图表跟着变

   用法：页面里先引 echarts.min.js，再引 charts.js，然后写
        ChartKit.loadData().then(function (data) { ... })
   ========================================================================= */
var ChartKit = (function () {
  "use strict";

  /* ------------------------------------------------------------------
     一、设计常量（和 css/style.css 里的主题色保持一致）
     ------------------------------------------------------------------ */
  var THEME = {
    font: '"PingFang SC","Microsoft YaHei",system-ui,sans-serif',
    green: "#22c55e",       // 绿：空闲
    greenDark: "#13794c",
    greenLight: "#a7f3d0",
    yellow: "#f5b301",      // 黄：一般
    red: "#ef4444",         // 红：繁忙
    axis: "#cfded6",        // 坐标轴线颜色
    text: "#5f7a6d",        // 次要文字
    title: "#10281d"        // 主要文字
  };

  // 饼图用的三种绿色（从深到浅）
  var PIE_COLORS = ["#16a34a", "#48c98a", "#a7f3d0"];

  // 所有页面的 ECharts 实例都存这里，(id -> 实例)，方便统一 resize
  var instances = {};

  /* ------------------------------------------------------------------
     二、小工具函数
     ------------------------------------------------------------------ */
  /** 数字格式化：12345.67 -> "12,345.7" */
  function formatNumber(value, digits) {
    var d = typeof digits === "number" ? digits : 1;
    var text = Number(value).toFixed(d);            // 先保留 d 位小数
    return text.replace(/\B(?=(\d{3})+(?!\d))/g, ","); // 整数部分每 3 位加逗号
  }

  /** 百分比格式化：0.834 -> "83%" */
  function formatPercent(ratio) {
    return Math.round(Number(ratio) * 100) + "%";
  }

  /** 把数字补成两位：8 -> "08" */
  function pad2(num) {
    return num < 10 ? "0" + num : String(num);
  }

  /* ------------------------------------------------------------------
     三、读取数据（data.json 是网页唯一数据源）
     ------------------------------------------------------------------ */
  /**
   * 用 fetch 读取同目录下的 data.json。
   * 返回 Promise；如果失败，会把页面上的 .alert 提示条显示出来（而不是静默白屏）。
   */
  function loadData() {
    return fetch("data.json", { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("data.json 请求失败，状态码 " + response.status);
        }
        return response.json();
      })
      .then(function (data) {
        // 简单校验一下数据结构，避免页面出现"数据 undefined"的怪现象
        if (!data || !data.stations || !data.hourly || !data.carbon) {
          throw new Error("data.json 结构不完整，请先运行 python process.py");
        }
        window.GREEN_DATA = data; // 挂到全局，方便调试时在控制台查看
        return data;
      })
      .catch(function (error) {
        var alertBox = document.querySelector(".alert");
        if (alertBox) {
          alertBox.textContent =
            "数据加载失败：" + error.message +
            "。请确认已在本项目目录用 python -m http.server 启动服务后访问页面。";
          alertBox.classList.add("show");
        }
        throw error;
      });
  }

  /* ------------------------------------------------------------------
     四、业务计算：占用率 / 忙闲状态 / 预计等待
     ------------------------------------------------------------------ */
  /**
   * 取某个小时、某个场站的平均订单数。
   * 数据里 hourly 是 {"18": {"城南站": 5.6, ...}} 这种结构。
   */
  function ordersAt(data, hour, station) {
    var row = data.hourly[String(hour)];
    return row && typeof row[station] === "number" ? row[station] : 0;
  }

  /** 取某个小时、某个场站的平均充电量（度） */
  function kwhAt(data, hour, station) {
    var row = data.hourlyKwh && data.hourlyKwh[String(hour)];
    return row && typeof row[station] === "number" ? row[station] : 0;
  }

  /**
   * 占用率 = 该小时订单数 ÷ 该站单小时最高订单数（capacity）。
   * 为什么用 capacity 当分母？因为它来自真实 CSV 统计，不是我拍脑袋编的常数；
   * 这样 1.0 就代表"这个站最忙的那一小时"。
   */
  function occupancy(data, hour, station) {
    var peak = data.capacity && data.capacity[station] ? data.capacity[station] : 1;
    var ratio = ordersAt(data, hour, station) / peak;
    if (!isFinite(ratio) || ratio < 0) ratio = 0;
    return Math.min(ratio, 1.2); // 留一点余量，防止极端数据把进度条撑爆
  }

  /**
   * 把占用率翻译成"忙闲状态 + 颜色 + 文案"。
   * 阈值：< 45% 空闲（绿） / < 75% 一般（黄） / 其余繁忙（红）
   */
  function statusOf(ratio) {
    if (ratio < 0.45) {
      return { key: "idle", label: "空闲", color: THEME.green, advice: "随到随充，几乎不用等" };
    }
    if (ratio < 0.75) {
      return { key: "normal", label: "一般", color: THEME.yellow, advice: "可能排队 1 台车" };
    }
    return { key: "busy", label: "繁忙", color: THEME.red, advice: "建议换个时段或换一站" };
  }

  /**
   * 预计等待分钟数（经验公式，只用于演示）：
   *   占用率越高，等待越久；低于 20% 基本不用等。
   *   (占用率 - 0.2) × 28，再取整并限制在 0~30 分钟之间。
   */
  function waitMinutes(ratio) {
    var minutes = Math.round((ratio - 0.2) * 28);
    if (minutes < 0) minutes = 0;
    if (minutes > 30) minutes = 30;
    return minutes;
  }

  /* ------------------------------------------------------------------
     五、ECharts 通用配置
     ------------------------------------------------------------------ */
  /** 图表统一的文字样式，避免每张图重复写 */
  function baseTextStyle() {
    return { fontFamily: THEME.font, color: THEME.title };
  }

  /**
   * 初始化（或取出已有的）ECharts 实例。
   * 同一个容器反复 setOption 比反复 init 更省内存，也不会闪。
   */
  function getChart(domId) {
    var dom = document.getElementById(domId);
    if (!dom) return null;
    if (!instances[domId]) {
      instances[domId] = echarts.init(dom, null, { renderer: "canvas" });
    }
    return instances[domId];
  }

  /**
   * 柱状图：三个场站在该时段的充电量对比
   * @param {string} domId  容器 id
   * @param {object} data   data.json 内容
   * @param {number} hour   0-23
   */
  function createBarChart(domId, data, hour) {
    var chart = getChart(domId);
    if (!chart) return null;

    var stations = data.stations;
    var values = stations.map(function (station) {
      return Number(kwhAt(data, hour, station).toFixed(1));
    });

    chart.setOption({
      textStyle: baseTextStyle(),
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        valueFormatter: function (v) { return v + " 度"; }
      },
      grid: { left: 8, right: 18, top: 38, bottom: 8, containLabel: true },
      xAxis: {
        type: "category",
        data: stations,
        axisTick: { show: false },
        axisLine: { lineStyle: { color: THEME.axis } },
        axisLabel: { color: THEME.text, fontSize: 13, fontWeight: 600 }
      },
      yAxis: {
        type: "value",
        name: "度(kWh)",
        nameTextStyle: { color: THEME.text, fontSize: 12, padding: [0, 0, 6, 0] },
        splitLine: { lineStyle: { color: "#eef6f1" } },
        axisLabel: { color: THEME.text, fontSize: 12 }
      },
      series: [{
        type: "bar",
        barWidth: "46%",
        data: values.map(function (v, i) {
          // 每根柱子用不同深浅的绿，第一名最深
          var color = i === 0 ? THEME.greenDark : (i === 1 ? "#22c55e" : "#86efac");
          return {
            value: v,
            itemStyle: {
              borderRadius: [10, 10, 4, 4],
              color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                { offset: 0, color: color },
                { offset: 1, color: color + "99" } // 加 99 是让它半透明
              ])
            }
          };
        }),
        label: {
          show: true,
          position: "top",
          color: THEME.title,
          fontWeight: 700,
          formatter: function (p) { return formatNumber(p.value, 1); }
        },
        animationDuration: 600
      }]
    }, true); // true = 不合并旧配置，切换小时时数据更干净
    return chart;
  }

  /**
   * 饼图（环形）：三站充电量份额
   */
  function createPieChart(domId, data, hour) {
    var chart = getChart(domId);
    if (!chart) return null;

    var stations = data.stations;
    var seriesData = stations.map(function (station, index) {
      return {
        name: station,
        value: Number(kwhAt(data, hour, station).toFixed(1)),
        itemStyle: { color: PIE_COLORS[index % PIE_COLORS.length] }
      };
    });
    var total = seriesData.reduce(function (sum, item) { return sum + item.value; }, 0);

    chart.setOption({
      textStyle: baseTextStyle(),
      tooltip: {
        trigger: "item",
        formatter: function (p) {
          return p.name + "<br/>" + formatNumber(p.value, 1) + " 度（" + p.percent + "%）";
        }
      },
      legend: {
        bottom: 0,
        icon: "circle",
        itemWidth: 9,
        itemHeight: 9,
        textStyle: { color: THEME.text, fontSize: 13 }
      },
      series: [{
        type: "pie",
        radius: ["46%", "70%"],   // 内外半径 -> 环形图
        center: ["50%", "45%"],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: "#fff", borderWidth: 3, borderRadius: 6 },
        label: {
          show: true,
          formatter: "{b}\n{d}%",
          color: THEME.title,
          fontSize: 12,
          lineHeight: 16
        },
        labelLine: { length: 10, length2: 10, lineStyle: { color: THEME.axis } },
        data: seriesData,
        animationDuration: 600
      }],
      // 环形中心显示合计充电量，比空着好看
      graphic: [{
        type: "text",
        left: "center",
        top: "40%",
        style: {
          text: formatNumber(total, 0) + " 度",
          fill: THEME.greenDark,
          fontSize: 20,
          fontWeight: 800,
          fontFamily: THEME.font,
          textAlign: "center"
        }
      }]
    }, true);
    return chart;
  }

  /**
   * 横向条形图：预约推荐页展示三站该时段的占用率
   * @param {Array<string>} categories 场站名
   * @param {Array<number>} ratios     每个站的占用率（0~1）
   * @param {string} bestStation       推荐的那个站（它的柱子加深）
   */
  function createHBarChart(domId, categories, ratios, bestStation) {
    var chart = getChart(domId);
    if (!chart) return null;

    // 横向条形图的 y 轴是从下往上画的，倒序之后"第一个站"才会出现在最上面
    var names = categories.slice().reverse();
    var values = ratios.slice().reverse();
    var bestIndex = names.indexOf(bestStation);

    chart.setOption({
      textStyle: baseTextStyle(),
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        valueFormatter: function (v) { return Math.round(v * 100) + "%"; }
      },
      grid: { left: 8, right: 56, top: 20, bottom: 8, containLabel: true },
      xAxis: {
        type: "value",
        max: 1.2,
        splitLine: { lineStyle: { color: "#eef6f1" } },
        axisLabel: { color: THEME.text, fontSize: 12, formatter: function (v) { return Math.round(v * 100) + "%"; } }
      },
      yAxis: {
        type: "category",
        data: names,
        axisTick: { show: false },
        axisLine: { lineStyle: { color: THEME.axis } },
        axisLabel: { color: THEME.title, fontSize: 14, fontWeight: 700 }
      },
      series: [{
        type: "bar",
        barWidth: 26,
        data: values.map(function (v, i) {
          var status = statusOf(v);
          return {
            value: v,
            itemStyle: {
              borderRadius: [0, 10, 10, 0],
              // 推荐的那一站用更饱和的深绿，一眼就能看出来
              color: i === bestIndex
                ? new echarts.graphic.LinearGradient(0, 0, 1, 0, [
                    { offset: 0, color: "#16a34a" },
                    { offset: 1, color: "#0f5132" }
                  ])
                : status.color + "b3"   // b3 = 70% 透明度
            }
          };
        }),
        label: {
          show: true,
          position: "right",
          fontWeight: 700,
          color: THEME.title,
          formatter: function (p) { return Math.round(p.value * 100) + "%"; }
        },
        animationDuration: 600
      }]
    }, true);
    return chart;
  }

  /**
   * 窗口大小变化时，把所有图表重新算一遍尺寸（否则图表会被拉伸变形）
   */
  function resizeAll() {
    Object.keys(instances).forEach(function (key) {
      if (instances[key] && instances[key].resize) instances[key].resize();
    });
  }

  // 浏览器窗口尺寸变化 -> 防抖 -> 重新 resize
  var resizeTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resizeAll, 120);
  });

  /* ------------------------------------------------------------------
     六、对外暴露（页面里用 ChartKit.xxx 调用）
     ------------------------------------------------------------------ */
  return {
    THEME: THEME,
    loadData: loadData,
    ordersAt: ordersAt,
    kwhAt: kwhAt,
    occupancy: occupancy,
    statusOf: statusOf,
    waitMinutes: waitMinutes,
    formatNumber: formatNumber,
    formatPercent: formatPercent,
    pad2: pad2,
    createBarChart: createBarChart,
    createPieChart: createPieChart,
    createHBarChart: createHBarChart,
    resizeAll: resizeAll
  };
})();
