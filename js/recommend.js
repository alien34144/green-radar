/* =========================================================================
   recommend.js —— 预约推荐页的逻辑

   一句话原理：
     把"周几 + 几点"对应的历史平均订单数，换算成三个站各自的占用率，
     挑占用率最低的那一站，就是最不用等的站。

   数据从哪来：
     data.json 里的 weekdayHourly（周几 -> 小时 -> 站 -> 平均订单数）
     和 capacity（每个站单小时最高订单数，作为占用率的分母）。
   ========================================================================= */
(function () {
  "use strict";

  var WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  var state = { data: null };

  var weekdaySelect = document.getElementById("weekdaySelect");
  var hourSelect = document.getElementById("hourSelect");
  var recommendBtn = document.getElementById("recommendBtn");

  /* ---------- 1. 填下拉框：周几 + 0-23 点 ---------- */
  WEEKDAYS.forEach(function (name) {
    var option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    weekdaySelect.appendChild(option);
  });
  for (var h = 0; h < 24; h++) {
    var hourOption = document.createElement("option");
    hourOption.value = String(h);
    hourOption.textContent = ChartKit.pad2(h) + ":00";
    hourSelect.appendChild(hourOption);
  }
  // 默认停在周五 19 点（晚高峰，最能体现"推荐"的价值）
  weekdaySelect.value = "周五";
  hourSelect.value = "19";

  /* ---------- 2. 读数据，读到了先自动推荐一次 ---------- */
  ChartKit.loadData()
    .then(function (data) {
      state.data = data;
      document.getElementById("dataNote").textContent =
        "数据范围：" + data.meta["日期范围"] + " · 共 " + data.meta["记录数"] + " 条记录";
      recommend(); // 打开页面就自动算一次，避免空着
    })
    .catch(function (error) {
      console.warn("数据加载失败：", error);
    });

  /* ---------- 3. 按钮和下拉框都触发推荐 ---------- */
  recommendBtn.addEventListener("click", recommend);
  weekdaySelect.addEventListener("change", recommend);
  hourSelect.addEventListener("change", recommend);

  /**
   * 取某天某小时，三个站的"平均订单数"。
   * 优先用 weekdayHourly（更精确）；万一数据里没有这一天，就退回到全体平均 hourly。
   */
  function ordersFor(data, weekday, hour) {
    var table = data.weekdayHourly && data.weekdayHourly[weekday];
    var fallback = data.hourly[String(hour)];
    return data.stations.map(function (station) {
      if (table && table[String(hour)] && typeof table[String(hour)][station] === "number") {
        return table[String(hour)][station];
      }
      return typeof fallback[station] === "number" ? fallback[station] : 0;
    });
  }

  /* ---------- 4. 推荐主函数 ---------- */
  function recommend() {
    var data = state.data;
    if (!data) return;

    var weekday = weekdaySelect.value;
    var hour = hourSelect.value;
    var stations = data.stations;
    var orders = ordersFor(data, weekday, hour);

    // 占用率 = 该时段平均订单数 ÷ 该站单小时最高订单数
    var ratios = orders.map(function (value, index) {
      var peak = data.capacity[stations[index]] || 1;
      var ratio = value / peak;
      return isFinite(ratio) && ratio > 0 ? ratio : 0;
    });

    var minRatio = Math.min.apply(null, ratios);
    var allSame = ratios.every(function (value) { return Math.abs(value - ratios[0]) < 1e-6; });
    var bestIndex = ratios.indexOf(minRatio);
    var bestStation = stations[bestIndex];
    var wait = ChartKit.waitMinutes(minRatio);

    var mainEl = document.getElementById("resultMain");
    var subEl = document.getElementById("resultSub");

    if (allSame) {
      // 三站一样闲（或一样忙），没必要纠结，随便哪一站都行
      mainEl.innerHTML = "任意一站均可";
      subEl.textContent = "这个时段三站占用率完全一样，去最近的就行。";
    } else {
      mainEl.innerHTML = "推荐去<span class=\"station-name\">「" + bestStation + "」</span>，预计等待约 " + wait + " 分钟";
      // 如果还有别的站一样空，也顺手告诉用户，更贴心
      var sameBest = stations.filter(function (s, i) {
        return i !== bestIndex && Math.abs(ratios[i] - minRatio) < 1e-6;
      });
      subEl.textContent = sameBest.length
        ? "「" + sameBest.join("」「") + "」同样空闲，就近选择也可以。"
        : "这个时段是 " + weekday + " " + ChartKit.pad2(Number(hour)) + ":00，占用率越低越不用等。";
    }

    /* ---------- 4.1 三站占用率对比小条 ---------- */
    var chipsEl = document.getElementById("compareChips");
    chipsEl.innerHTML = stations.map(function (station, index) {
      var status = ChartKit.statusOf(ratios[index]);
      var isBest = index === bestIndex && !allSame;
      return "<span class=\"compare-chip" + (isBest ? " best" : "") + "\" style=\"--state-color: " + status.color + "\">" +
        "<i></i>" + station + " " + ChartKit.formatPercent(ratios[index]) +
        "（" + status.label + "）</span>";
    }).join("");

    /* ---------- 4.2 横向条形图 ---------- */
    ChartKit.createHBarChart("hbarChart", stations, ratios, allSame ? null : bestStation);
    document.getElementById("hbarHint").textContent =
      weekday + " " + ChartKit.pad2(Number(hour)) + ":00 · 占用率越低越空闲";

    // 把原始订单数也显示在提示里，方便老师/评委追问数据怎么来的
    document.getElementById("orderNote").textContent =
      "该时段历史平均订单数：" + stations.map(function (station, index) {
        return station + " " + orders[index].toFixed(1) + " 单";
      }).join(" · ");
  }
})();
