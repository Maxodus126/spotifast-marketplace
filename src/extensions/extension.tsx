// NAME: Spotifast Marketplace Extension
// AUTHOR: theRealPadster, CharlieS1103
// DESCRIPTION: Companion extension for Spotifast Marketplace

import { t } from "i18next";

import { CUSTOM_APP_PATH, LOCALSTORAGE_KEYS, MARKETPLACE_VERSION } from "../constants";
import { fetchAppManifest, fetchExtensionManifest, fetchThemeManifest, getBlacklist, getNextPage, getTaggedRepos } from "../logic/FetchRemotes";
import { hydrateMarketplaceStorage, marketplaceStorage } from "../logic/Storage";
import {
  addExtensionToSpicetifyConfig,
  exportMarketplace,
  getAvailableTLD,
  getLocalStorageDataFromKey,
  getParamsFromGithubRaw,
  initAlbumArtBasedColor,
  initColorShiftLoop,
  initializeSnippets,
  injectColourScheme,
  // TODO: there's a slightly different copy of this function in Card.ts?
  injectUserCSS,
  isGithubRawUrl,
  parseCSS,
  resetMarketplace,
  sleep
} from "../logic/Utils";
import type { RepoType } from "../types/marketplace-types";

(async function init() {
  if (!Spicetify.LocalStorage || !Spicetify.showNotification) {
    setTimeout(init, 100);
    return;
  }

  // https://github.com/satya164/react-simple-code-editor/issues/86
  const reactSimpleCodeEditorFix = document.createElement("script");
  reactSimpleCodeEditorFix.innerHTML = "const global = globalThis;";
  document.body.appendChild(reactSimpleCodeEditorFix);

  // Show message on start.
  console.log(`Initializing Spotifast Marketplace v${MARKETPLACE_VERSION}`);
  try {
    await hydrateMarketplaceStorage();
  } catch (error) {
    // The installed lists are unknown here, so loading nothing is safer than
    // rebuilding Spicetify's config from an empty view.
    console.error("Marketplace storage could not be read", error);
    Spicetify.showNotification(t("notifications.storageUnreadable"), true, 5000);
    return;
  }

  // Expose useful methods in global context
  window.Marketplace = {
    // Should allow you to reset Marketplace from the dev console if it's b0rked
    reset: resetMarketplace,
    // Export all marketplace localstorage keys
    export: exportMarketplace,
    version: MARKETPLACE_VERSION
  };

  const tld = await getAvailableTLD();

  const initializeExtension = (extensionKey: string) => {
    const extensionManifest = getLocalStorageDataFromKey(extensionKey);
    // Abort if no manifest found or no extension URL (i.e. a theme)
    if (!extensionManifest?.extensionURL) return;

    console.debug("Initializing extension: ", extensionManifest);

    const script = document.createElement("script");
    script.defer = true;
    script.src = extensionManifest.extensionURL;

    // If it's a github raw script, use jsdelivr
    if (isGithubRawUrl(script.src)) {
      const { user, repo, branch, filePath } = getParamsFromGithubRaw(extensionManifest.extensionURL);
      if (!user || !repo || !branch || !filePath) return;
      script.src = `https://cdn.jsdelivr.${tld}/gh/${user}/${repo}@${branch}/${filePath}`;
      if (filePath.endsWith(".mjs")) script.type = "module";
    }

    script.src = `${script.src}?time=${Date.now()}`;

    document.body.appendChild(script);

    // Add to Spicetify.Config
    addExtensionToSpicetifyConfig(extensionManifest.manifest?.main);
  };

  const initializeTheme = async (themeKey: string) => {
    const themeManifest = getLocalStorageDataFromKey(themeKey);
    // Abort if no manifest found
    if (!themeManifest) {
      console.debug("No theme manifest found");
      return;
    }

    console.debug("Initializing theme: ", themeManifest);

    // Inject colour scheme if found
    if (themeManifest.schemes) {
      const activeSchemeName = themeManifest.activeScheme ?? Object.keys(themeManifest.schemes)[0];
      const activeScheme = themeManifest.schemes[activeSchemeName];
      injectColourScheme(activeScheme);

      // Add to Spicetify.Config
      // @ts-expect-error: `color_scheme` is read-only type in types
      Spicetify.Config.color_scheme = activeSchemeName;
      if (marketplaceStorage.getItem(LOCALSTORAGE_KEYS.albumArtBasedColor) === "true") {
        initAlbumArtBasedColor(activeScheme);
      } else if (marketplaceStorage.getItem(LOCALSTORAGE_KEYS.colorShift) === "true") {
        initColorShiftLoop(themeManifest.schemes);
      }
    } else {
      console.warn("No schemes found for theme");
    }

    // Remove default css
    // TODO: what about if we remove the theme? Should we re-add the user.css/colors.css?
    // const existingUserThemeCSS = document.querySelector("link[href='user.css']");
    // if (existingUserThemeCSS) existingUserThemeCSS.remove();

    // Remove any existing marketplace theme
    const existingMarketplaceThemeCSS = document.querySelector("link.marketplaceCSS");
    if (existingMarketplaceThemeCSS) existingMarketplaceThemeCSS.remove();

    // Add theme css
    // A CSS failure shouldn't stop the theme's included JS from loading below
    try {
      const userCSS = await parseCSS(themeManifest, tld);
      injectUserCSS(userCSS);
    } catch (error) {
      console.error("Failed to inject theme CSS", error);
    }

    // Add to Spicetify.Config
    // @ts-expect-error: `current_theme` is read-only type in types
    Spicetify.Config.current_theme = themeManifest.manifest?.name;

    // Inject any included js
    if (themeManifest.include?.length) {
      // console.log("Including js", installedThemeData.include);

      for (const script of themeManifest.include) {
        const newScript = document.createElement("script");
        let src = script;

        // If it's a github raw script, use jsdelivr
        if (isGithubRawUrl(script)) {
          const { user, repo, branch, filePath } = getParamsFromGithubRaw(script);
          if (!user || !repo || !branch || !filePath) return;
          src = `https://cdn.jsdelivr.${tld}/gh/${user}/${repo}@${branch}/${filePath}`;
          if (filePath.endsWith(".mjs")) newScript.type = "module";
        }
        // console.log({src});
        newScript.src = `${src}?time=${Date.now()}`;
        newScript.classList.add("marketplaceScript");
        document.body.appendChild(newScript);

        // Add to Spicetify.Config
        addExtensionToSpicetifyConfig(script);
      }
    }
  };

  console.log("Loaded Marketplace extension");

  const installedSnippetKeys = getLocalStorageDataFromKey(LOCALSTORAGE_KEYS.installedSnippets, []);
  const installedSnippets = installedSnippetKeys.map((key) => getLocalStorageDataFromKey(key));
  initializeSnippets(installedSnippets);

  if (!tld) {
    if (window.navigator.onLine) {
      console.error(new Error("Unable to connect to the CDN, please check your Internet configuration."));
      Spicetify.showNotification(t("notifications.noCdnConnection"), true, 5000);
    } else {
      // Reload Marketplace extension in case the user couldn't connect to the CDN because they were offline
      window.addEventListener("online", init, { once: true });
    }

    return;
  }

  window.sessionStorage.setItem("marketplace-request-tld", tld);

  const installedExtensions = getLocalStorageDataFromKey(LOCALSTORAGE_KEYS.installedExtensions, []);
  for (const extensionKey of installedExtensions) {
    initializeExtension(extensionKey);
  }

  const { current_theme: localTheme } = Spicetify.Config;
  marketplaceStorage.setItem(LOCALSTORAGE_KEYS.localTheme, localTheme);
  const installedTheme = marketplaceStorage.getItem(LOCALSTORAGE_KEYS.themeInstalled);
  if (installedTheme) {
    if (localTheme.toLocaleLowerCase() !== "marketplace") {
      Spicetify.showNotification(t("notifications.wrongLocalTheme"), true, 5000);
      return;
    }
    initializeTheme(installedTheme);
  }
})();

/**
 * TODO
 * @param type The repo type
 * @param pageNum The page number
 * @returns TODO
 */
async function queryRepos(type: RepoType, pageNum = 1) {
  const BLACKLIST: string[] = JSON.parse(window.sessionStorage.getItem("marketplace:blacklist") || "[]");
  const sortMode = marketplaceStorage.getItem(LOCALSTORAGE_KEYS.sort) || "stars";

  // Go through getTaggedRepos so the request and its sessionStorage cache key match
  // what the Grid asks for, and opening Marketplace reuses these pages.
  // silent=true keeps GitHub rate-limit (403) failures quiet during preload.
  return getTaggedRepos(`spicetify-${type}s`, pageNum, BLACKLIST, true, sortMode, true);
}

/**
 * TODO
 * @param type The repo type
 * @param pageNum The page number
 * @returns TODO
 */
// Cap the number of pages preloaded so startup stays bounded.
const MAX_PRELOAD_PAGES = 3;

async function waitForMarketplaceOpen(timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const path = Spicetify.Platform.History?.location?.pathname;
    if (typeof path === "string" && path.startsWith(CUSTOM_APP_PATH)) return true;
    await sleep(1000);
  }
  return false;
}

(async function initializePreload() {
  // Only preload once Marketplace is actually opened, not on every startup.
  if (!(await waitForMarketplaceOpen())) return;

  console.debug("Preloading extensions and themes...");
  window.sessionStorage.clear();
  const BLACKLIST = await getBlacklist();
  window.sessionStorage.setItem("marketplace:blacklist", JSON.stringify(BLACKLIST));
  // queryRepos reads the saved sort mode, so wait for storage to load first.
  // init() already reports a failure to the user.
  await hydrateMarketplaceStorage().catch(() => undefined);

  let pagesProcessed = 0;
  const processType = async (type: RepoType) => {
    let page = 0;
    // Stop after MAX_PRELOAD_PAGES pages, and stop early when a page comes back
    // empty (e.g. GitHub rate-limit), since getNextPage then yields no next page.
    while (pagesProcessed < MAX_PRELOAD_PAGES) {
      const pageOfRepos = await queryRepos(type, page);
      if (pageOfRepos.items?.length) appendInformationToLocalStorage(pageOfRepos, type);
      pagesProcessed++;
      const nextPage = getNextPage(page, pageOfRepos);
      if (!nextPage) break;
      page = nextPage;
    }
    console.debug(`Preload finished for ${type}`);
  };

  await Promise.all([processType("extension"), processType("theme"), processType("app")]);
})();

async function appendInformationToLocalStorage(array, type: RepoType) {
  // This system should make it so themes and extensions are stored concurrently
  for (const repo of array.items) {
    if (type === "theme") await fetchThemeManifest(repo.contents_url, repo.default_branch, repo.stargazers_count);
    else if (type === "extension") await fetchExtensionManifest(repo.contents_url, repo.default_branch, repo.stargazers_count);
    else if (type === "app") await fetchAppManifest(repo.contents_url, repo.default_branch, repo.stargazers_count);
  }
}
