const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim();

export const USE_MOCK_API = !configuredBaseUrl;
export const API_BASE_URL = (configuredBaseUrl || "/api").replace(/\/+$/, "");
