(function () {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";
  var CHART_HEIGHT = 240;
  var PAD = { top: 12, right: 12, bottom: 28 };
  var Y_TICKS = 4;
  var RANGES = ["1w", "1m", "3m", "6m", "1y", "5y"];
  var FALLBACK_PAIR = ["USD", "EUR"];

  function format(template) {
    var args = Array.prototype.slice.call(arguments, 1);

    return String(template).replace(/%(\d+)/g, function (match, index) {
      var value = args[Number(index) - 1];

      return value === undefined ? match : value;
    });
  }

  function svgEl(name, attrs) {
    var el = document.createElementNS(SVG_NS, name);

    Object.keys(attrs || {}).forEach(function (key) {
      el.setAttribute(key, attrs[key]);
    });

    return el;
  }

  function pluckRates(history) {
    return history.map(function (point) {
      return point.rate;
    });
  }

  function readJson(response) {
    return response
      .json()
      .catch(function () {
        return {};
      })
      .then(function (body) {
        if (!response.ok || !body || body.error) {
          throw new Error("request_failed");
        }

        return body;
      });
  }

  function Converter(root) {
    var i18nEl = root.querySelector('[data-role="i18n"]');

    this.root = root;
    this.proxyUrl = root.getAttribute("data-proxy-url");
    this.uid = root.getAttribute("data-uid") || "cc";
    this.locale =
      root.getAttribute("data-locale") ||
      document.documentElement.lang ||
      undefined;
    this.i18n = {};
    try {
      this.i18n = JSON.parse(i18nEl ? i18nEl.textContent : "{}");
    } catch (error) {
      this.i18n = {};
    }
    this.data = null;
    this.request = null;
    this.supported = {};
    this.els = {
      form: root.querySelector('[data-role="form"]'),
      amount: root.querySelector('[data-role="amount"]'),
      from: root.querySelector('[data-role="from"]'),
      to: root.querySelector('[data-role="to"]'),
      swap: root.querySelector('[data-role="swap"]'),
      converted: root.querySelector('[data-role="converted"]'),
      rate: root.querySelector('[data-role="rate"]'),
      meta: root.querySelector('[data-role="meta"]'),
      error: root.querySelector('[data-role="error"]'),
      stats: root.querySelector('[data-role="stats"]'),
      chart: root.querySelector('[data-role="chart"]'),
      ranges: Array.prototype.slice.call(root.querySelectorAll("[data-range]")),
    };

    var range = (root.getAttribute("data-range") || "").toLowerCase();

    this.state = {
      from: (root.getAttribute("data-from") || "").toUpperCase(),
      to: (root.getAttribute("data-to") || "").toUpperCase(),
      range: RANGES.indexOf(range) !== -1 ? range : "3m",
      amount: 1,
    };

    this.bind();
    this.syncControls();
    this.loadCurrencies();
  }

  Converter.prototype.t = function (key) {
    return this.i18n[key] || key;
  };

  Converter.prototype.url = function (path, params) {
    var url = new URL(this.proxyUrl + "/" + path, window.location.origin);

    Object.keys(params || {}).forEach(function (key) {
      url.searchParams.set(key, params[key]);
    });

    return url.toString();
  };

  Converter.prototype.bind = function () {
    var self = this;

    this.els.form.addEventListener("submit", function (event) {
      event.preventDefault();
    });
    this.els.from.addEventListener("change", function () {
      self.state.from = self.els.from.value;
      self.load();
    });
    this.els.to.addEventListener("change", function () {
      self.state.to = self.els.to.value;
      self.load();
    });
    this.els.swap.addEventListener("click", this.swap.bind(this));
    this.els.amount.addEventListener("input", this.onAmountInput.bind(this));
    this.els.ranges.forEach(function (button) {
      button.addEventListener("click", function () {
        self.selectRange(button.getAttribute("data-range"));
      });
    });
    this.observeResize();
  };

  Converter.prototype.loadCurrencies = function () {
    var self = this;

    this.setLoading(true);
    fetch(this.url("currencies"), { headers: { Accept: "application/json" } })
      .then(readJson)
      .then(function (body) {
        var currencies = Array.isArray(body.currencies) ? body.currencies : [];

        if (!currencies.length) {
          throw new Error("empty_currency_list");
        }
        self.populateSelects(currencies);
        self.resolveDefaults(currencies);
        self.els.from.disabled = false;
        self.els.to.disabled = false;
        self.syncControls();
        self.load();
      })
      .catch(function () {
        self.showData(null, self.t("loadError"));
      });
  };

  Converter.prototype.populateSelects = function (currencies) {
    var self = this;
    var groups = [
      ["currency", this.t("groupCurrency")],
      ["metal", this.t("groupMetal")],
      ["crypto", this.t("groupCrypto")],
    ];

    [this.els.from, this.els.to].forEach(function (select) {
      select.textContent = "";
      groups.forEach(function (group) {
        var items = currencies.filter(function (currency) {
          return currency.type === group[0];
        });
        var optgroup;

        if (!items.length) {
          return;
        }
        optgroup = document.createElement("optgroup");
        optgroup.label = group[1];
        items.forEach(function (currency) {
          var option = document.createElement("option");

          option.value = currency.code;
          option.textContent = currency.code + " · " + currency.name;
          optgroup.appendChild(option);
        });
        select.appendChild(optgroup);
      });
    });

    currencies.forEach(function (currency) {
      self.supported[currency.code] = true;
    });
  };

  /**
   * Keep the configured pair when it is supported, otherwise fall back to a
   * common pair. From and To are never the same on first load.
   */
  Converter.prototype.resolveDefaults = function (currencies) {
    var supported = this.supported;
    var from = this.state.from;
    var to = this.state.to;
    var pick = function (exclude) {
      var candidates = FALLBACK_PAIR.concat(
        currencies.map(function (currency) {
          return currency.code;
        }),
      );

      for (var i = 0; i < candidates.length; i++) {
        if (supported[candidates[i]] && candidates[i] !== exclude) {
          return candidates[i];
        }
      }

      return exclude;
    };

    if (!supported[from]) {
      from = pick(to);
    }
    if (!supported[to] || to === from) {
      to = pick(from);
    }
    this.state.from = from;
    this.state.to = to;
  };

  Converter.prototype.swap = function () {
    var from = this.state.from;

    this.state.from = this.state.to;
    this.state.to = from;
    this.syncControls();
    this.load();
  };

  Converter.prototype.onAmountInput = function () {
    var value = parseFloat(this.els.amount.value);

    this.state.amount = isFinite(value) && value >= 0 ? value : NaN;
    this.renderResult();
  };

  Converter.prototype.selectRange = function (range) {
    if (this.state.range === range || RANGES.indexOf(range) === -1) {
      return;
    }
    this.state.range = range;
    this.syncControls();
    this.load();
  };

  /**
   * Redraw whenever the container width differs from the width the chart was
   * last drawn at. The SVG is drawn in real pixels, so it is never stretched.
   */
  Converter.prototype.observeResize = function () {
    var self = this;

    if (!window.ResizeObserver) {
      window.addEventListener("resize", function () {
        self.renderChart();
      });
      return;
    }
    new ResizeObserver(function () {
      if (self.data && self.els.chart.clientWidth !== self.chartWidth) {
        self.renderChart();
      }
    }).observe(this.els.chart);
  };

  Converter.prototype.syncControls = function () {
    var range = this.state.range;

    this.els.from.value = this.state.from;
    this.els.to.value = this.state.to;
    this.els.ranges.forEach(function (button) {
      button.setAttribute(
        "aria-pressed",
        button.getAttribute("data-range") === range ? "true" : "false",
      );
    });
  };

  Converter.prototype.load = function () {
    var self = this;

    if (!this.supported[this.state.from] || !this.supported[this.state.to]) {
      return;
    }
    if (this.request) {
      this.request.abort();
    }
    this.request = new AbortController();
    this.setLoading(true);

    fetch(
      this.url("rate", {
        from: this.state.from,
        to: this.state.to,
        range: this.state.range,
      }),
      {
        headers: { Accept: "application/json" },
        signal: this.request.signal,
      },
    )
      .then(readJson)
      .then(function (body) {
        self.showData(body, "");
      })
      .catch(function (error) {
        if (error.name !== "AbortError") {
          self.showData(null, self.t("loadError"));
        }
      });
  };

  Converter.prototype.showData = function (data, errorMessage) {
    this.data = data;
    this.setLoading(false);
    this.els.error.textContent = errorMessage;
    this.els.error.hidden = !errorMessage;
    this.renderResult();
    this.renderStats();
    this.renderChart();
  };

  Converter.prototype.setLoading = function (loading) {
    this.root.classList.toggle("is-loading", loading);
    this.els.chart.setAttribute("aria-busy", loading ? "true" : "false");
    if (loading && !this.data) {
      this.els.meta.textContent = this.t("loading");
    }
  };

  Converter.prototype.formatRate = function (value) {
    var options =
      Math.abs(value) >= 1
        ? { maximumFractionDigits: 4 }
        : { maximumSignificantDigits: 6 };

    return new Intl.NumberFormat(this.locale, options).format(value);
  };

  Converter.prototype.formatAmount = function (value) {
    var options =
      Math.abs(value) >= 1 || value === 0
        ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
        : { maximumSignificantDigits: 6 };

    return new Intl.NumberFormat(this.locale, options).format(value);
  };

  Converter.prototype.formatDate = function (iso, short) {
    var parts = iso.split("-");
    var date = new Date(Date.UTC(+parts[0], +parts[1] - 1, +parts[2]));
    var options = {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    };

    if (short) {
      options =
        this.state.range === "5y"
          ? { year: "numeric", month: "short", timeZone: "UTC" }
          : { month: "short", day: "numeric", timeZone: "UTC" };
    }

    return new Intl.DateTimeFormat(this.locale, options).format(date);
  };

  Converter.prototype.renderResult = function () {
    var data = this.data;
    var amount = this.state.amount;
    var converted = this.els.converted;
    var source;
    var target;
    var unit;

    converted.textContent = "";
    if (!data) {
      this.els.rate.textContent = "\u00a0";
      if (!this.root.classList.contains("is-loading")) {
        this.els.meta.textContent = "\u00a0";
      }

      return;
    }

    if (isNaN(amount)) {
      converted.textContent = this.t("invalidAmount");
    } else {
      source = document.createElement("span");
      source.className = "cc__converted-from";
      source.textContent = this.formatAmount(amount) + " " + data.from + " =";
      target = document.createElement("span");
      target.className = "cc__converted-to";
      target.textContent = this.formatAmount(amount * data.rate) + " ";
      unit = document.createElement("span");
      unit.className = "cc__converted-unit";
      unit.textContent = data.to;
      target.appendChild(unit);
      converted.appendChild(source);
      converted.appendChild(target);
    }
    this.els.rate.textContent = "";
    [
      "1 " + data.from + " = " + this.formatRate(data.rate) + " " + data.to,
      "1 " + data.to + " = " + this.formatRate(1 / data.rate) + " " + data.from,
    ].forEach(function (text, index, parts) {
      var span = document.createElement("span");

      span.textContent = text;
      this.els.rate.appendChild(span);
      if (index < parts.length - 1) {
        this.els.rate.appendChild(document.createTextNode(" \u00b7 "));
      }
    }, this);
    this.els.meta.textContent = format(
      this.t("rateAsOf"),
      this.formatDate(data.date),
    );
  };

  Converter.prototype.renderStats = function () {
    var self = this;
    var stats = this.els.stats;
    var history = this.data ? this.data.history : [];
    var rates;
    var change;
    var trend;

    stats.textContent = "";
    if (!history || history.length < 2) {
      return;
    }

    rates = pluckRates(history);
    change = ((rates[rates.length - 1] - rates[0]) / rates[0]) * 100;
    trend = change > 0 ? "up" : change < 0 ? "down" : "";
    [
      [
        this.t("change"),
        (change > 0 ? "+" : "") + change.toFixed(2) + "%",
        trend,
      ],
      [this.t("high"), this.formatRate(Math.max.apply(null, rates)), ""],
      [this.t("low"), this.formatRate(Math.min.apply(null, rates)), ""],
    ].forEach(function (item) {
      var wrapper = document.createElement("div");
      var dt = document.createElement("dt");
      var dd = document.createElement("dd");

      dt.textContent = item[0];
      dd.textContent = item[1];
      if (item[0] === self.t("change")) {
        dd.className = "cc__badge" + (item[2] ? " is-" + item[2] : "");
      }
      wrapper.appendChild(dt);
      wrapper.appendChild(dd);
      stats.appendChild(wrapper);
    });
  };

  Converter.prototype.renderChart = function () {
    var container = this.els.chart;
    var history = this.data ? this.data.history : [];
    var width = container.clientWidth;
    var empty;
    var scale;
    var svg;

    container.textContent = "";
    this.chartWidth = width;
    if (!this.data) {
      return;
    }
    if (!history || history.length < 2) {
      empty = document.createElement("p");
      empty.className = "cc__empty";
      empty.textContent = this.t("noHistory");
      container.appendChild(empty);

      return;
    }

    // Not laid out yet (hidden tab, collapsed section, late stylesheet): the
    // resize observer draws the chart once the container has a real width.
    if (width < 1) {
      return;
    }

    scale = this.buildScale(history, Math.max(width, 200));
    svg = svgEl("svg", {
      viewBox: "0 0 " + scale.width + " " + CHART_HEIGHT,
      width: scale.width,
      height: CHART_HEIGHT,
      role: "img",
      tabindex: "0",
      "aria-label": format(this.t("chartLabel"), this.data.from, this.data.to),
    });

    this.drawAxes(svg, scale, history);
    this.drawSeries(svg, scale, history);
    container.appendChild(svg);
    this.attachTooltip(svg, scale, history);
  };

  Converter.prototype.buildScale = function (history, width) {
    var rates = pluckRates(history);
    var min = Math.min.apply(null, rates);
    var max = Math.max.apply(null, rates);
    var spread = max - min || Math.abs(max) * 0.01 || 1;
    var step;
    var decimals;
    var axisFormat;
    var labels = [];
    var padLeft;
    var plotW;
    var plotH;
    var i;

    min -= spread * 0.08;
    max += spread * 0.08;
    step = (max - min) / Y_TICKS;
    decimals = Math.min(10, Math.max(0, 1 - Math.floor(Math.log10(step))));
    axisFormat = new Intl.NumberFormat(this.locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    for (i = 0; i <= Y_TICKS; i++) {
      labels.push(axisFormat.format(min + step * i));
    }
    padLeft =
      14 +
      6.5 *
        Math.max.apply(
          null,
          labels.map(function (label) {
            return label.length;
          }),
        );
    plotW = width - padLeft - PAD.right;
    plotH = CHART_HEIGHT - PAD.top - PAD.bottom;

    return {
      width: width,
      padLeft: padLeft,
      plotW: plotW,
      plotH: plotH,
      min: min,
      step: step,
      labels: labels,
      x: function (index) {
        return padLeft + (index / (history.length - 1)) * plotW;
      },
      y: function (rate) {
        return PAD.top + (1 - (rate - min) / (max - min)) * plotH;
      },
    };
  };

  Converter.prototype.drawAxes = function (svg, scale, history) {
    var tickCount = Math.min(history.length, scale.width < 480 ? 3 : 5);
    var i;
    var gy;
    var label;
    var index;
    var anchor;
    var tick;

    for (i = 0; i <= Y_TICKS; i++) {
      gy = scale.y(scale.min + scale.step * i);
      svg.appendChild(
        svgEl("line", {
          x1: scale.padLeft,
          x2: scale.width - PAD.right,
          y1: gy,
          y2: gy,
          class: "cc__grid",
        }),
      );
      label = svgEl("text", {
        x: scale.padLeft - 8,
        y: gy + 4,
        "text-anchor": "end",
        class: "cc__axis",
      });
      label.textContent = scale.labels[i];
      svg.appendChild(label);
    }

    for (i = 0; i < tickCount; i++) {
      index = Math.round((i * (history.length - 1)) / (tickCount - 1));
      anchor = i === 0 ? "start" : i === tickCount - 1 ? "end" : "middle";
      tick = svgEl("text", {
        x: scale.x(index),
        y: CHART_HEIGHT - 8,
        "text-anchor": anchor,
        class: "cc__axis",
      });
      tick.textContent = this.formatDate(history[index].date, true);
      svg.appendChild(tick);
    }
  };

  Converter.prototype.drawSeries = function (svg, scale, history) {
    var gradientId = this.uid + "-gradient";
    var defs = svgEl("defs");
    var gradient = svgEl("linearGradient", {
      id: gradientId,
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 1,
    });
    var baseline = (PAD.top + scale.plotH).toFixed(2);
    var line = history
      .map(function (point, i) {
        return (
          (i ? "L" : "M") +
          scale.x(i).toFixed(2) +
          " " +
          scale.y(point.rate).toFixed(2)
        );
      })
      .join(" ");

    gradient.appendChild(
      svgEl("stop", { offset: "0%", class: "cc__area-stop-top" }),
    );
    gradient.appendChild(
      svgEl("stop", { offset: "100%", class: "cc__area-stop-bottom" }),
    );
    defs.appendChild(gradient);
    svg.appendChild(defs);
    svg.appendChild(
      svgEl("path", {
        d:
          line +
          " L" +
          scale.x(history.length - 1).toFixed(2) +
          " " +
          baseline +
          " L" +
          scale.x(0).toFixed(2) +
          " " +
          baseline +
          " Z",
        fill: "url(#" + gradientId + ")",
        class: "cc__area",
      }),
    );
    svg.appendChild(svgEl("path", { d: line, class: "cc__line" }));
    svg.appendChild(
      svgEl("circle", {
        cx: scale.x(history.length - 1).toFixed(2),
        cy: scale.y(history[history.length - 1].rate).toFixed(2),
        r: 3.5,
        class: "cc__end",
      }),
    );
  };

  Converter.prototype.attachTooltip = function (svg, scale, history) {
    var self = this;
    var container = this.els.chart;
    var cursor = svgEl("line", {
      y1: PAD.top,
      y2: PAD.top + scale.plotH,
      class: "cc__cursor",
      visibility: "hidden",
    });
    var dot = svgEl("circle", {
      r: 4.5,
      class: "cc__dot",
      visibility: "hidden",
    });
    var tooltip = document.createElement("div");
    var active = -1;
    var show = function (i) {
      var point;
      var px;
      var py;
      var ratio;

      active = Math.max(0, Math.min(history.length - 1, i));
      point = history[active];
      px = scale.x(active);
      py = scale.y(point.rate);
      ratio = svg.getBoundingClientRect().width / scale.width || 1;
      cursor.setAttribute("x1", px);
      cursor.setAttribute("x2", px);
      cursor.setAttribute("visibility", "visible");
      dot.setAttribute("cx", px);
      dot.setAttribute("cy", py);
      dot.setAttribute("visibility", "visible");
      tooltip.textContent =
        self.formatDate(point.date) +
        ": " +
        self.formatRate(point.rate) +
        " " +
        self.data.to;
      tooltip.hidden = false;
      tooltip.style.left =
        Math.min(Math.max(px * ratio, 60), container.clientWidth - 60) + "px";
      tooltip.style.top = py * ratio + "px";
    };
    var hide = function () {
      active = -1;
      cursor.setAttribute("visibility", "hidden");
      dot.setAttribute("visibility", "hidden");
      tooltip.hidden = true;
    };

    tooltip.className = "cc__tooltip";
    tooltip.hidden = true;
    svg.appendChild(cursor);
    svg.appendChild(dot);
    container.appendChild(tooltip);

    svg.addEventListener("pointermove", function (event) {
      var rect = svg.getBoundingClientRect();
      var localX = (event.clientX - rect.left) * (scale.width / rect.width);

      show(
        Math.round(
          ((localX - scale.padLeft) / scale.plotW) * (history.length - 1),
        ),
      );
    });
    svg.addEventListener("pointerleave", hide);
    svg.addEventListener("blur", hide);
    svg.addEventListener("keydown", function (event) {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        show(
          (active === -1 ? history.length - 1 : active) +
            (event.key === "ArrowLeft" ? -1 : 1),
        );
      } else if (event.key === "Escape") {
        hide();
      }
    });
  };

  function init(scope) {
    Array.prototype.forEach.call(
      (scope || document).querySelectorAll("[data-currency-converter]"),
      function (root) {
        if (!root.ccConverter) {
          root.ccConverter = new Converter(root);
        }
      },
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      init(document);
    });
  } else {
    init(document);
  }

  // Theme editor re-renders sections in place; boot any new blocks.
  document.addEventListener("shopify:section:load", function (event) {
    init(event.target);
  });
})();
