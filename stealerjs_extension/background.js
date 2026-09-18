let attachedTabId = null;

// Use the new chrome.runtime.onMessage format
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getAllStorageData") {
    handleGetAllStorageData(sendResponse);
    return true; // Indicates we wish to send a response asynchronously
  } else if (request.action === "setStorageData") {
    handleSetStorageData(request, sendResponse);
    return true;
  }
});

// Helper functions to handle message actions
async function handleGetAllStorageData(sendResponse) {
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    await attachDebugger(tab.id);
    const [cookies, localStorage] = await Promise.all([
      getAllCookies(),
      getLocalStorage(tab.id)
    ]);
    sendResponse({
      url: tab.url,
      cookies: cookies,
      localStorage: localStorage
    });
  } catch (error) {
    console.error("Error:", error);
    sendResponse({error: error.message});
  } finally {
    if (attachedTabId !== null) {
      await detachDebugger(attachedTabId);
    }
  }
}

async function handleSetStorageData(request, sendResponse) {
  try {
    const data = JSON.parse(request.data);
    const cookies = Array.isArray(data.cookies) ? data.cookies : [];
    const localStorage = data.localStorage && typeof data.localStorage === "object" && !Array.isArray(data.localStorage)
      ? data.localStorage
      : {};
    const hasCookies = cookies.length > 0;
    const hasLocalStorage = Object.keys(localStorage).length > 0;

    if (!hasCookies && !hasLocalStorage) {
      sendResponse({success: true});
      return;
    }

    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    await attachDebugger(tab.id);
    const cookieFailures = hasCookies ? await setCookies(tab.url, cookies) : [];
    if (hasLocalStorage) {
      await setLocalStorage(tab.id, localStorage);
    }
    sendResponse({
      success: true,
      ...(cookieFailures.length > 0 && {warnings: cookieFailures})
    });
  } catch (error) {
    console.error("Error:", error);
    sendResponse({error: error.message});
  } finally {
    if (attachedTabId !== null) {
      await detachDebugger(attachedTabId);
    }
  }
}

async function attachDebugger(tabId) {
  if (attachedTabId === tabId) return;
  if (attachedTabId !== null) {
    await chrome.debugger.detach({tabId: attachedTabId});
  }
  await chrome.debugger.attach({tabId: tabId}, "1.3");
  attachedTabId = tabId;
}

async function detachDebugger(tabId) {
  if (attachedTabId === tabId) {
    await chrome.debugger.detach({tabId: tabId});
    attachedTabId = null;
  }
}

function sendCommand(method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({tabId: attachedTabId}, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve(result);
      }
    });
  });
}

async function getAllCookies() {
  const result = await sendCommand("Network.getAllCookies");
  return result.cookies;
}

async function getLocalStorage(tabId) {
  const script = `
    Object.entries(localStorage).reduce((acc, [key, value]) => {
      acc[key] = value;
      return acc;
    }, {})
  `;
  const result = await sendCommand("Runtime.evaluate", {
    expression: script,
    returnByValue: true
  });
  return result.result.value;
}

async function setCookies(url, cookies) {
  const failures = [];

  for (const cookie of cookies) {
    const description = [cookie.name || "(unnamed cookie)", cookie.domain || url]
      .filter(Boolean)
      .join(" @ ");

    try {
      const result = await sendCommand("Network.setCookie", {
        ...cookie,
        url: url
      });

      if (result.success === false) {
        throw new Error("Cookie was rejected by the browser");
      }
    } catch (error) {
      const failure = `${description}: ${error.message || error}`;
      failures.push(failure);
      console.warn("Cookie import failed:", failure);
    }
  }

  return failures;
}

async function setLocalStorage(tabId, items) {
  const script = Object.entries(items).map(([key, value]) => {
    return `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)});`;
  }).join('\n');
  
  await sendCommand("Runtime.evaluate", {
    expression: script
  });
}

// Keep the service worker alive
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});
