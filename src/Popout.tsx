// @ts-nocheck

import * as React from "react";
import * as ReactDOM from "react-dom";
import { PopoutProps } from "./PopoutProps";
import { generateWindowFeaturesString } from "./generateWindowFeaturesString";
import { popouts } from "./popouts";
import { crossBrowserCloneNode } from "./crossBrowserCloneNode";
import * as globalContext from "./globalContext";
import "./childWindowMonitor";
import { debug } from "console";

export class Popout extends React.Component<PopoutProps, {}> {
    private id: string;

    private container: HTMLElement | null;

    private setupAttempts = 0;

    private isFin = window.fin != null;

    public styleElement: HTMLStyleElement | null;

    public child: Window | null;

    private async setupOnCloseHandler(id: string, child: Window) {
        if (this.isFin) {
            const win = await fin.Window.getCurrent();
            const webWin = win.getWebWindow();

            webWin.addEventListener("beforeunload", () => {
                this.setupCleanupCallbacks();
            });

            return;
        }

        // For Edge, IE browsers, the document.head might not exist here yet. We will just simply attempt again when RAF is called
        // For Firefox, on the setTimeout, the child window might actually be set to null after the first attempt if there is a popup blocker
        if (this.setupAttempts >= 5) {
            return;
        }

        if (child && child.document && child.document.head) {
            const unloadScriptContainer =
                child.document.createElement("script");
            const onBeforeUnloadLogic = `
            window.onbeforeunload = function(e) {
                var result = window.opener.${globalContext.id}.onBeforeUnload.call(window, '${id}', e);

                if (result) {
                    window.opener.${globalContext.id}.startMonitor.call(window.opener, '${id}');

                    e.returnValue = result;
                    return result;
                } else {
                    window.opener.${globalContext.id}.onChildClose.call(window.opener, '${id}');
                }
            }`;

            // Use onload for most URL scenarios to allow time for the page to load first
            // Safari 11.1 is aggressive, so it will call onbeforeunload prior to the page being created.
            unloadScriptContainer.innerHTML = `
            window.onload = function(e) {
                ${onBeforeUnloadLogic}
            };
            `;

            // For edge and IE, they don't actually execute the onload logic, so we just want the onBeforeUnload logic.
            // If this isn't a URL scenario, we have to bind onBeforeUnload directly too.
            if (isBrowserIEOrEdge() || !this.props.url) {
                unloadScriptContainer.innerHTML = onBeforeUnloadLogic;
            }

            child.document.head.appendChild(unloadScriptContainer);

            this.setupCleanupCallbacks();
        } else {
            this.setupAttempts++;
            setTimeout(() => this.setupOnCloseHandler(id, child), 50);
        }
    }

    private async setupCleanupCallbacks() {
        // Close the popout if main window is closed.
        if (this.isFin) {
            this.closeChildWindowIfOpened();
        } else {
            window.addEventListener("unload", (e) =>
                this.closeChildWindowIfOpened()
            );
        }

        globalContext.set("onChildClose", (id: string) => {
            if (popouts[id].props.onClose) {
                popouts[id].props.onClose!();
            }
        });

        globalContext.set(
            "onBeforeUnload",
            (id: string, evt: BeforeUnloadEvent) => {
                if (popouts[id].props.onBeforeUnload) {
                    return popouts[id].props.onBeforeUnload!(evt);
                }
            }
        );
    }

    private setupStyleElement(child: Window) {
        this.styleElement = child.document.createElement("style");
        this.styleElement.setAttribute("data-this-styles", "true");
        this.styleElement.type = "text/css";

        child.document.head.appendChild(this.styleElement);
    }

    private injectHtml(id: string, child: Window) {
        let container: HTMLDivElement;

        if (this.props.html) {
            child.document.write(this.props.html);
            const head = child.document.head;

            let cssText = "";
            let rules = null;

            for (let i = window.document.styleSheets.length - 1; i >= 0; i--) {
                let styleSheet = window.document.styleSheets[
                    i
                ] as CSSStyleSheet;
                try {
                    rules = styleSheet.cssRules;
                } catch {
                    // We're primarily looking for a security exception here.
                    // See https://bugs.chromium.org/p/chromium/issues/detail?id=775525
                    // Try to just embed the style element instead.
                    let styleElement = child.document.createElement("link");
                    styleElement.type = styleSheet.type;
                    styleElement.rel = "stylesheet";
                    styleElement.href = styleSheet.href;
                    head.appendChild(styleElement);
                } finally {
                    if (rules) {
                        for (let j = 0; j < rules.length; j++) {
                            try {
                                cssText += rules[j].cssText;
                            } catch {
                                // IE11 will throw a security exception sometimes when accessing cssText.
                                // There's no good way to detect this, so we capture the exception instead.
                            }
                        }
                    }
                }

                rules = null;
            }

            const style = child.document.createElement("style");
            style.innerHTML = cssText;

            head.appendChild(style);
            container = child.document.createElement("div");
            container.id = id;
            child.document.body.appendChild(container);
        } else {
            let childHtml = "<!DOCTYPE html><html><head>";
            for (let i = window.document.styleSheets.length - 1; i >= 0; i--) {
                let styleSheet = window.document.styleSheets[
                    i
                ] as CSSStyleSheet;
                try {
                    const cssText = styleSheet.cssText;
                    childHtml += `<style>${cssText}</style>`;
                } catch {
                    // IE11 will throw a security exception sometimes when accessing cssText.
                    // There's no good way to detect this, so we capture the exception instead.
                }
            }
            childHtml += `</head><body><div id="${id}"></div></body></html>`;
            child.document.write(childHtml);
            container = child.document.getElementById(id)! as HTMLDivElement;
        }

        // Create a document with the styles of the parent window first
        this.setupStyleElement(child);

        return container;
    }

    private setupStyleObserver(child: Window) {
        // Add style observer for legacy style node additions
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.type == "childList") {
                    forEachStyleElement(mutation.addedNodes, (element) => {
                        child.document.head.appendChild(
                            crossBrowserCloneNode(element, child.document)
                        );
                    });
                }
            });
        });

        const config = { childList: true };

        observer.observe(document.head, config);
    }

    private async initializeChildWindow(id: string, child: Window) {
        popouts[id] = this;

        let win = null;
        try {
            win = await child;
        } catch (e) {
            console.error("child window", e);
        }

        if (!this.props.url) {
            const container: HTMLDivElement = this.injectHtml(id, win);
            this.setupStyleObserver(win);
            this.setupOnCloseHandler(id, win);
            return container;
        } else {
            this.setupOnCloseHandler(id, win);

            return null;
        }
    }

    private runtimeWindow = async (name, title, options) => {
        if (this.isFin) {
            const { onClose, url } = this.props;
            const winOption = {
                name,
                defaultWidth: 400,
                defaultHeight: 500,
                url,
                backgroundColor: options.backgroundColor || "#fff",
                frame: true,
                saveWindowState: true,
                autoShow: true,
                alwaysOnTop: true,
                accelerator: {
                    devtools: true,
                    zoom: true,
                },
            };

            const win = window.fin.Window.create(winOption);

            let appWin = null;
            try {
                appWin = await win;
            } catch (e) {
                console.error("runtime window", e);
            }

            appWin.addListener("reloaded", () => {
                this.closeChildWindowIfOpened();
            });

            appWin.addListener("closed", async () => {
                if (onClose) {
                    try {
                        await onClose();
                    } catch (e) {
                        console.error("child evt closed", e);
                    }
                }
            });

            const webWin = appWin.getWebWindow();
            webWin.document.title = title;

            return webWin;
        }

        const win = window.open(this.props.url || "about:blank", name, options);
        win.addEventListener(
            "DOMContentLoaded",
            () => (win.document.title = title)
        );
        return win;
    };

    private openChildWindow = () => {
        const options = generateWindowFeaturesString(this.props.options || {});

        const name = getWindowName(this.props.name!);
        const title = getWindowTitle(this.props.title!);

        this.child = validatePopupBlocker(
            this.runtimeWindow(name, title, options)
        );

        if (!this.child) {
            if (this.props.onBlocked) {
                this.props.onBlocked();
            }
            this.container = null;
        } else {
            this.id = `__${name}_container__`;
            this.container = this.initializeChildWindow(this.id, this.child!);
        }
    };

    private closeChildWindowIfOpened = async () => {
        let win = null;
        try {
            win = await this.child;
        } catch (e) {
            console.error("child window", e);
        }
        if (isChildWindowOpened(win)) {
            if (this.isFin) {
                try {
                    await win.close(true);
                } catch (e) {
                    console.error("close opened child win", e);
                }
            } else {
                win!.close();
            }
            this.child = null;

            if (this.props.onClose) {
                this.props.onClose();
            }
        }
    };

    private renderChildWindow() {
        validateUrl(this.props.url!);

        if (!this.props.hidden) {
            if (!isChildWindowOpened(this.child)) {
                this.openChildWindow();
            }

            if (!this.props.url && this.container) {
                ReactDOM.render(this.props.children, this.container);
            }
        } else {
            this.closeChildWindowIfOpened();
        }
    }

    componentDidUpdate() {
        this.renderChildWindow();
    }

    componentDidMount() {
        this.renderChildWindow();
    }

    componentWillUnmount() {
        this.closeChildWindowIfOpened();
    }

    render() {
        return null;
    }
}

function validateUrl(url: string) {
    if (!url) {
        return;
    }

    const parser = document.createElement("a");
    parser.href = url;

    const current = window.location;

    if (
        (parser.hostname && current.hostname != parser.hostname) ||
        (parser.protocol && current.protocol != parser.protocol)
    ) {
        throw new Error(
            `react-popup-component error: cross origin URLs are not supported (window=${current.protocol}//${current.hostname}; popout=${parser.protocol}//${parser.hostname})`
        );
    }
}

async function validatePopupBlocker(child: Window) {
    let win = null;
    try {
        win = await child;
    } catch (e) {
        console.error("child window", e);
    }
    if (window.fin) {
        // TODO: OpenFin logic required?
        return child;
    }

    if (
        !win ||
        win.closed ||
        typeof win == "undefined" ||
        typeof win.closed == "undefined"
    ) {
        return null;
    }
    return child;
}

function isChildWindowOpened(child: Window | null) {
    return child && !child.closed;
}

function getWindowName(name: string) {
    return name || Math.random().toString(12).slice(2);
}

function getWindowTitle(title?: string) {
    return title || "";
}

function forEachStyleElement(
    nodeList: NodeList,
    callback: (element: HTMLElement, index?: number) => void,
    scope?: any
) {
    let element: HTMLElement;

    for (let i = 0; i < nodeList.length; i++) {
        element = nodeList[i] as HTMLElement;
        if (element.tagName == "STYLE") {
            callback.call(scope, element, i);
        }
    }
}

function isBrowserIEOrEdge() {
    const userAgent =
        typeof navigator != "undefined" && navigator.userAgent
            ? navigator.userAgent
            : "";
    return /Edge/.test(userAgent) || /Trident/.test(userAgent);
}
