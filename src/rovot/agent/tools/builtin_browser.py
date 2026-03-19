"""Browser tools registration for the ToolRegistry."""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

from rovot.agent.tools.registry import Tool, ToolRegistry

if TYPE_CHECKING:
    from rovot.connectors.browser import BrowserConnector


def register_browser_tools(registry: ToolRegistry, browser: BrowserConnector | None) -> None:
    """Register browser tools. No-op if browser is None (connector disabled)."""
    if browser is None:
        return

    registry.register(
        Tool(
            name="browser.navigate",
            description="Navigate to a URL in the browser. Returns page title and cleaned text content.",
            parameters={
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "The URL to navigate to"},
                },
                "required": ["url"],
            },
            fn=browser.navigate,
            requires_approval=False,
        )
    )

    registry.register(
        Tool(
            name="browser.search",
            description="Search the web using a search engine and return top results. DuckDuckGo (default), Google, or Bing.",
            parameters={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "The search query"},
                    "engine": {
                        "type": "string",
                        "enum": ["duckduckgo", "google", "bing"],
                        "description": "Search engine to use (default: duckduckgo)",
                    },
                },
                "required": ["query"],
            },
            fn=browser.search,
            requires_approval=False,
        )
    )

    registry.register(
        Tool(
            name="browser.get_page_content",
            description="Get the title and cleaned text content of the current browser page.",
            parameters={
                "type": "object",
                "properties": {},
                "required": [],
            },
            fn=browser.get_page_content,
            requires_approval=False,
        )
    )

    registry.register(
        Tool(
            name="browser.screenshot",
            description="Take a screenshot of the current browser page. Returns base64-encoded PNG.",
            parameters={
                "type": "object",
                "properties": {},
                "required": [],
            },
            fn=browser.screenshot,
            requires_approval=False,
        )
    )

    registry.register(
        Tool(
            name="browser.click",
            description="Click an element on the current page by CSS selector or text content.",
            parameters={
                "type": "object",
                "properties": {
                    "selector": {
                        "type": "string",
                        "description": "CSS selector, text content, or aria-label of element to click",
                    },
                },
                "required": ["selector"],
            },
            fn=browser.click,
            requires_approval=True,
            approval_summary="Click a browser element (could submit forms or trigger actions)",
        )
    )

    async def _type_text(selector: str, text: str) -> Any:
        return await browser.type_text(selector, text)

    registry.register(
        Tool(
            name="browser.type",
            description="Type text into an input field on the current page.",
            parameters={
                "type": "object",
                "properties": {
                    "selector": {
                        "type": "string",
                        "description": "CSS selector of the input field",
                    },
                    "text": {"type": "string", "description": "Text to type"},
                },
                "required": ["selector", "text"],
            },
            fn=_type_text,
            requires_approval=True,
            approval_summary="Type text into a browser field (could enter data or credentials)",
        )
    )
