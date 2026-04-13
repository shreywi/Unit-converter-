const categorySelect = document.getElementById("category-select");
const fromValueInput = document.getElementById("from-value");
const toValueInput = document.getElementById("to-value");
const fromUnitSelect = document.getElementById("from-unit");
const toUnitSelect = document.getElementById("to-unit");
const swapButton = document.getElementById("swap-btn");
const statusEl = document.getElementById("status");
const errorEl = document.getElementById("error");

let lastEdited = "from";
let currencyRates = null;
let ratesUpdatedAt = null;
let ratesRequestInFlight = null;

const RATE_TTL_MS = 30 * 60 * 1000;
const CURRENCY_CODES = ["USD", "INR", "EUR", "GBP", "JPY"];

const UNIT_CONFIG = {
  length: {
    units: ["m", "km", "cm", "mm", "mile", "ft"],
    factors: {
      m: 1,
      km: 1000,
      cm: 0.01,
      mm: 0.001,
      mile: 1609.344,
      ft: 0.3048,
    },
  },
  weight: {
    units: ["kg", "g", "mg", "lb"],
    factors: {
      kg: 1,
      g: 0.001,
      mg: 0.000001,
      lb: 0.45359237,
    },
  },
  temperature: {
    units: ["C", "F", "K"],
  },
  speed: {
    units: ["km/h", "m/s", "mph"],
    factors: {
      "m/s": 1,
      "km/h": 0.2777777778,
      mph: 0.44704,
    },
  },
  currency: {
    units: CURRENCY_CODES,
  },
};

function setStatus(text) {
  statusEl.textContent = text;
}

function setError(text) {
  errorEl.textContent = text;
}

function clearError() {
  setError("");
}

function normalizeNumberInput(raw) {
  if (String(raw).trim() === "") {
    return null;
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error("Please enter a valid number.");
  }

  return value;
}

function formatConvertedValue(value, category) {
  const maxFractionDigits = category === "currency" ? 4 : 6;
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: maxFractionDigits,
  }).format(value);
}

function createUnitOptions(category) {
  const units = UNIT_CONFIG[category].units;

  fromUnitSelect.innerHTML = "";
  toUnitSelect.innerHTML = "";

  units.forEach((unit) => {
    const fromOption = document.createElement("option");
    fromOption.value = unit;
    fromOption.textContent = unit;

    const toOption = document.createElement("option");
    toOption.value = unit;
    toOption.textContent = unit;

    fromUnitSelect.appendChild(fromOption);
    toUnitSelect.appendChild(toOption);
  });

  fromUnitSelect.value = units[0];
  toUnitSelect.value = units[1] || units[0];
}

// Linear conversion for length, weight, and speed.
// Step 1: convert from source unit to a base unit using factors.
// Step 2: convert from base unit to target unit.
function convertLinear(value, category, fromUnit, toUnit) {
  const factors = UNIT_CONFIG[category].factors;
  const baseValue = value * factors[fromUnit];
  return baseValue / factors[toUnit];
}

// Temperature conversion via Celsius as the common intermediary.
function convertTemperature(value, fromUnit, toUnit) {
  let celsius = 0;

  if (fromUnit === "C") {
    celsius = value;
  } else if (fromUnit === "F") {
    celsius = ((value - 32) * 5) / 9;
  } else {
    celsius = value - 273.15;
  }

  if (toUnit === "C") {
    return celsius;
  }

  if (toUnit === "F") {
    return (celsius * 9) / 5 + 32;
  }

  return celsius + 273.15;
}

// Currency conversion uses USD as pivot.
// rates map is "1 USD = rate[currency]".
// from -> USD: amount / rate[from]
// USD -> to: usdAmount * rate[to]
function convertCurrency(value, fromUnit, toUnit) {
  if (!currencyRates || !currencyRates[fromUnit] || !currencyRates[toUnit]) {
    throw new Error("Live exchange rates are not available yet.");
  }

  const usdAmount = value / currencyRates[fromUnit];
  return usdAmount * currencyRates[toUnit];
}

function convertValue(value, category, fromUnit, toUnit) {
  if (fromUnit === toUnit) {
    return value;
  }

  if (category === "temperature") {
    return convertTemperature(value, fromUnit, toUnit);
  }

  if (category === "currency") {
    return convertCurrency(value, fromUnit, toUnit);
  }

  return convertLinear(value, category, fromUnit, toUnit);
}

function parseRatesFromExchangeRateHost(payload) {
  if (!payload || !payload.rates) {
    return null;
  }

  const rates = { USD: 1 };

  CURRENCY_CODES.forEach((code) => {
    const value = Number(payload.rates[code]);
    if (Number.isFinite(value)) {
      rates[code] = value;
    }
  });

  return CURRENCY_CODES.every((code) => Number.isFinite(rates[code])) ? rates : null;
}

function parseRatesFromErApi(payload) {
  if (!payload || !payload.rates) {
    return null;
  }

  const rates = { USD: 1 };

  CURRENCY_CODES.forEach((code) => {
    const value = Number(payload.rates[code]);
    if (Number.isFinite(value)) {
      rates[code] = value;
    }
  });

  return CURRENCY_CODES.every((code) => Number.isFinite(rates[code])) ? rates : null;
}

async function fetchRatesFromExchangeRateHost() {
  const symbolsParam = CURRENCY_CODES.join(",");
  const url = `https://api.exchangerate.host/latest?base=USD&symbols=${encodeURIComponent(symbolsParam)}`;
  const response = await fetch(url, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Primary rate API request failed.");
  }

  const data = await response.json();
  const parsedRates = parseRatesFromExchangeRateHost(data);

  if (!parsedRates) {
    throw new Error("Primary rate API returned invalid data.");
  }

  return parsedRates;
}

async function fetchRatesFromErApi() {
  const response = await fetch("https://open.er-api.com/v6/latest/USD", { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Fallback rate API request failed.");
  }

  const data = await response.json();
  const parsedRates = parseRatesFromErApi(data);

  if (!parsedRates) {
    throw new Error("Fallback rate API returned invalid data.");
  }

  return parsedRates;
}

async function ensureCurrencyRates(forceRefresh = false) {
  if (!forceRefresh && currencyRates && ratesUpdatedAt && Date.now() - ratesUpdatedAt < RATE_TTL_MS) {
    return currencyRates;
  }

  if (ratesRequestInFlight) {
    return ratesRequestInFlight;
  }

  setStatus("Updating currency rates...");

  ratesRequestInFlight = (async () => {
    try {
      const rates = await fetchRatesFromExchangeRateHost();
      currencyRates = rates;
      ratesUpdatedAt = Date.now();
      setStatus("Live currency rates updated.");
      return rates;
    } catch (primaryError) {
      const fallbackRates = await fetchRatesFromErApi();
      currencyRates = fallbackRates;
      ratesUpdatedAt = Date.now();
      setStatus("Live rates updated using fallback provider.");
      return fallbackRates;
    } finally {
      ratesRequestInFlight = null;
    }
  })();

  return ratesRequestInFlight;
}

async function runConversion() {
  clearError();

  const category = categorySelect.value;
  const fromUnit = fromUnitSelect.value;
  const toUnit = toUnitSelect.value;

  try {
    if (category === "currency") {
      await ensureCurrencyRates();
    }

    if (lastEdited === "to") {
      const toValue = normalizeNumberInput(toValueInput.value);
      if (toValue === null) {
        fromValueInput.value = "";
        return;
      }

      const convertedBack = convertValue(toValue, category, toUnit, fromUnit);
      fromValueInput.value = formatConvertedValue(convertedBack, category);
    } else {
      const fromValue = normalizeNumberInput(fromValueInput.value);
      if (fromValue === null) {
        toValueInput.value = "";
        return;
      }

      const converted = convertValue(fromValue, category, fromUnit, toUnit);
      toValueInput.value = formatConvertedValue(converted, category);
    }

    if (category !== "currency") {
      setStatus("Converted instantly.");
    }
  } catch (error) {
    setError(error.message || "Conversion failed.");
  }
}

function handleCategoryChange() {
  const category = categorySelect.value;
  createUnitOptions(category);
  fromValueInput.value = "";
  toValueInput.value = "";
  lastEdited = "from";
  clearError();

  if (category === "currency") {
    ensureCurrencyRates().catch(() => {
      setError("Unable to load live currency rates right now.");
    });
  } else {
    setStatus("Ready");
  }
}

categorySelect.addEventListener("change", () => {
  handleCategoryChange();
});

fromValueInput.addEventListener("input", () => {
  lastEdited = "from";
  runConversion();
});

toValueInput.addEventListener("input", () => {
  lastEdited = "to";
  runConversion();
});

fromUnitSelect.addEventListener("change", () => {
  runConversion();
});

toUnitSelect.addEventListener("change", () => {
  runConversion();
});

swapButton.addEventListener("click", () => {
  const originalFromUnit = fromUnitSelect.value;
  const originalToUnit = toUnitSelect.value;
  const originalFromValue = fromValueInput.value;
  const originalToValue = toValueInput.value;

  fromUnitSelect.value = originalToUnit;
  toUnitSelect.value = originalFromUnit;
  fromValueInput.value = originalToValue;
  toValueInput.value = originalFromValue;

  lastEdited = "from";
  runConversion();
});

handleCategoryChange();
