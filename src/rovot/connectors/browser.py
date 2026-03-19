"""Browser connector using Playwright for web automation."""
from __future__ import annotations

import base64
import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

_MAX_CONTENT_LENGTH = 8000


def _clean_text(text: str) -> str:
    """Collapse whitespace and truncate to max content length."""
    import re

    text = re.sub(r"\s+", " ", text).strip()
    return text[:_MAX_CONTENT_LENGTH]


async def _extract_content(page: Any) -> str:  # type: ignore[return]
    """Extract readable text from the current page."""
    try:
        import trafilatura  # type: ignore[import]

        html = await page.content()
        result = trafilatura.extract(html, include_tables=False, include_images=False)
        if result:
            return _clean_text(result)
    except ImportError:
        pass
    except Exception:
        pass

    # Fallback: strip boilerplate tags and get innerText
    try:
        await page.evaluate(
            """() => {
                const remove = ['script', 'style', 'nav', 'footer', 'header', 'noscript'];
                remove.forEach(tag => document.querySelectorAll(tag).forEach(el => el.remove()));
            }"""
        )
        text = await page.inner_text("body")
        return _clean_text(text)
    except Exception as exc:
        logger.warning("Failed to extract page content: %s", exc)
        return ""


@dataclass
class BrowserConnector:
    """Playwright-backed browser connector for web automation."""

    headless: bool = True
    user_data_dir: str = ""
    _browser: Any = field(default=None, init=False, repr=False)
    _context: Any = field(default=None, init=False, repr=False)
    _page: Any = field(default=None, init=False, repr=False)
    _playwright: Any = field(default=None, init=False, repr=False)

    async def _get_page(self) -> Any:
        """Lazy-init Playwright browser context and return current page."""
        if self._page is not None:
            return self._page

        try:
            from playwright.async_api import async_playwright  # type: ignore[import]
        except ImportError as exc:
            raise ImportError(
                "Browser connector requires Playwright with Chromium. "
                "Install with: pip install playwright && playwright install chromium"
            ) from exc

        self._playwright = await async_playwright().start()
        if self.user_data_dir:
            self._context = await self._playwright.chromium.launch_persistent_context(
                self.user_data_dir,
                headless=self.headless,
            )
            self._browser = None
        else:
            self._browser = await self._playwright.chromium.launch(headless=self.headless)
            self._context = await self._browser.new_context()

        self._page = await self._context.new_page()
        return self._page

    async def navigate(self, url: str) -> dict[str, Any]:
        """Navigate to URL and return page info with cleaned text content."""
        page = await self._get_page()
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=30000)
            title = await page.title()
            text = await _extract_content(page)
            return {"url": page.url, "title": title, "text_content": text}
        except Exception as exc:
            return {"error": str(exc), "url": url}

    async def search(self, query: str, engine: str = "duckduckgo") -> dict[str, Any]:
        """Search the web. DuckDuckGo (default), Google, or Bing."""
        encoded = query.replace(" ", "+")
        urls = {
            "duckduckgo": f"https://html.duckduckgo.com/html/?q={encoded}",
            "google": f"https://www.google.com/search?q={encoded}&hl=en",
            "bing": f"https://www.bing.com/search?q={encoded}",
        }
        url = urls.get(engine, urls["duckduckgo"])
        page = await self._get_page()
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=15000)
            results: list[dict[str, str]] = []
            if engine == "duckduckgo" or engine not in urls:
                links = await page.query_selector_all(".result__a")
                snippets = await page.query_selector_all(".result__snippet")
                for i, link in enumerate(links[:8]):
                    title = await link.inner_text()
                    href = await link.get_attribute("href") or ""
                    snippet = await snippets[i].inner_text() if i < len(snippets) else ""
                    if title and href:
                        results.append({
                            "title": title.strip(),
                            "url": href,
                            "snippet": snippet.strip(),
                        })
            else:
                text = await _extract_content(page)
                results = [{"title": query, "url": url, "snippet": text[:500]}]
            return {"query": query, "engine": engine, "results": results}
        except Exception as exc:
            return {"error": str(exc), "query": query}

    async def click(self, selector: str) -> dict[str, Any]:
        """Click an element by CSS selector, text, or aria-label."""
        page = await self._get_page()
        try:
            # Try CSS selector first, then text content
            try:
                await page.click(selector, timeout=5000)
            except Exception:
                await page.click(f"text={selector}", timeout=5000)
            return {"success": True, "selector": selector, "url": page.url}
        except Exception as exc:
            return {"error": str(exc), "selector": selector}

    async def type_text(self, selector: str, text: str) -> dict[str, Any]:
        """Type text into an input field identified by selector."""
        page = await self._get_page()
        try:
            await page.fill(selector, text, timeout=5000)
            return {"success": True, "selector": selector}
        except Exception as exc:
            return {"error": str(exc), "selector": selector}

    async def get_page_content(self) -> dict[str, Any]:
        """Get current page title and cleaned text content."""
        page = await self._get_page()
        try:
            title = await page.title()
            text = await _extract_content(page)
            return {"url": page.url, "title": title, "text_content": text}
        except Exception as exc:
            return {"error": str(exc)}

    async def screenshot(self) -> dict[str, Any]:
        """Take screenshot of current page and return base64 PNG."""
        page = await self._get_page()
        try:
            data = await page.screenshot(type="png")
            return {"base64": base64.b64encode(data).decode(), "format": "png"}
        except Exception as exc:
            return {"error": str(exc)}

    async def close(self) -> None:
        """Close the browser. Should be called at daemon shutdown."""
        try:
            if self._context:
                await self._context.close()
            if self._browser:
                await self._browser.close()
            if self._playwright:
                await self._playwright.stop()
        except Exception as exc:
            logger.warning("Error closing browser: %s", exc)
        finally:
            self._page = None
            self._context = None
            self._browser = None
            self._playwright = None
