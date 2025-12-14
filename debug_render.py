
from playwright.sync_api import sync_playwright

def check_errors():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        # Capture console messages
        page.on("console", lambda msg: print(f"CONSOLE: {msg.text}"))
        page.on("pageerror", lambda exc: print(f"ERROR: {exc}"))

        try:
            print("Navigating to page...")
            page.goto("http://localhost:8080/public/index.html")

            print("Clicking Demo...")
            page.click("text=Load Demo Data")

            # Check if canvas has content
            content = page.inner_html("#canvas")
            if "blueprint" in content and "socket" in content:
                print("SUCCESS: Canvas rendered content.")
            else:
                print("FAIL: Canvas is empty or missing blueprint.")
                print("Current Content:", content[:200])

        except Exception as e:
            print(f"EXCEPTION: {e}")
        finally:
            browser.close()

if __name__ == "__main__":
    check_errors()
