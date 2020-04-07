/// <reference path="../../built/pxtlib.d.ts"/>
import * as core from "./core";
import * as electron from "./electron";
import * as pkg from "./package";
import * as hidbridge from "./hidbridge";
import * as webusb from "./webusb";
import * as data from "./data";
import Cloud = pxt.Cloud;

function log(msg: string) {
    pxt.log(`cmds: ${msg}`);
}

let extensionResult: pxt.editor.ExtensionResult;
let tryPairedDevice = false;

function browserDownloadAsync(text: string, name: string, contentType: string): Promise<void> {
    pxt.BrowserUtils.browserDownloadBinText(
        text,
        name,
        contentType,
        undefined,
        e => core.errorNotification(lf("saving file failed..."))
    );

    return Promise.resolve();
}

export function browserDownloadDeployCoreAsync(resp: pxtc.CompileResult): Promise<void> {
    let url = ""
    const ext = pxt.outputName().replace(/[^.]*/, "")
    const out = resp.outfiles[pxt.outputName()]
    const fn = pkg.genFileName(ext);
    const userContext = pxt.BrowserUtils.isBrowserDownloadWithinUserContext();
    if (userContext) {
        url = pxt.BrowserUtils.toDownloadDataUri(pxt.isOutputText() ? ts.pxtc.encodeBase64(out) : out, pxt.appTarget.compile.hexMimeType);
    } else if (!pxt.isOutputText()) {
        log('saving ' + fn)
        url = pxt.BrowserUtils.browserDownloadBase64(
            out,
            fn,
            "application/x-uf2",
            resp.userContextWindow,
            e => core.errorNotification(lf("saving file failed..."))
        );
    } else {
        log('saving ' + fn)
        url = pxt.BrowserUtils.browserDownloadBinText(
            out,
            fn,
            pxt.appTarget.compile.hexMimeType,
            resp.userContextWindow,
            e => core.errorNotification(lf("saving file failed..."))
        );
    }

    if (!resp.success) {
        return Promise.resolve();
    }

    if (resp.saveOnly && userContext) return pxt.commands.showUploadInstructionsAsync(fn, url, core.confirmAsync); // save does the same as download as far iOS is concerned
    if (resp.saveOnly || pxt.BrowserUtils.isBrowserDownloadInSameWindow() && !userContext) return Promise.resolve();
    else return pxt.commands.showUploadInstructionsAsync(fn, url, core.confirmAsync);
}

function showUploadInstructionsAsync(fn: string, url: string, confirmAsync: (options: any) => Promise<number>): Promise<void> {
    const boardName = pxt.appTarget.appTheme.boardName || lf("device");
    const boardDriveName = pxt.appTarget.appTheme.driveDisplayName || pxt.appTarget.compile.driveName || "???";

    // https://msdn.microsoft.com/en-us/library/cc848897.aspx
    // "For security reasons, data URIs are restricted to downloaded resources.
    // Data URIs cannot be used for navigation, for scripting, or to populate frame or iframe elements"
    const userDownload = pxt.BrowserUtils.isBrowserDownloadWithinUserContext();
    const downloadAgain = !pxt.BrowserUtils.isIE() && !pxt.BrowserUtils.isEdge();
    const docUrl = pxt.appTarget.appTheme.usbDocs;
    const saveAs = pxt.BrowserUtils.hasSaveAs();
    const ext = pxt.appTarget.compile.useUF2 ? ".uf2" : ".hex";
    const body = userDownload ? lf("Click 'Download' to open the {0} app.", pxt.appTarget.appTheme.boardName) :
        saveAs ? lf("Click 'Save As' and save the {0} file to the {1} drive to transfer the code into your {2}.",
            ext,
            boardDriveName, boardName)
            : lf("Move the {0} file to the {1} drive to transfer the code into your {2}.",
                ext,
                boardDriveName, boardName);
    const timeout = pxt.BrowserUtils.isBrowserDownloadWithinUserContext() ? 0 : 10000;
    return confirmAsync({
        header: userDownload ? lf("Download ready...") : lf("Download completed..."),
        body,
        hasCloseIcon: true,
        hideCancel: true,
        hideAgree: true,
        buttons: [downloadAgain ? {
            label: userDownload ? lf("Download") : lf("Click to download again"),
            icon: "download",
            class: `${userDownload ? "primary" : "lightgrey"}`,
            url,
            fileName: fn
        } : undefined, docUrl ? {
            label: lf("Help"),
            icon: "help",
            class: "lightgrey",
            url: docUrl
        } : undefined],
        timeout
    }).then(() => { });
}

export function nativeHostPostMessageFunction(): (msg: pxt.editor.NativeHostMessage) => void {
    const webkit = (<any>window).webkit;
    if (webkit
        && webkit.messageHandlers
        && webkit.messageHandlers.host
        && webkit.messageHandlers.host.postMessage)
        return msg => webkit.messageHandlers.host.postMessage(msg);
    const android = (<any>window).android;
    if (android && android.postMessage)
        return msg => android.postMessage(JSON.stringify(msg));
    return undefined;
}

export function isNativeHost(): boolean {
    return !!nativeHostPostMessageFunction();
}

function nativeHostDeployCoreAsync(resp: pxtc.CompileResult): Promise<void> {
    log(`native deploy`)
    core.infoNotification(lf("Flashing device..."));
    const out = resp.outfiles[pxt.outputName()];
    const nativePostMessage = nativeHostPostMessageFunction();
    nativePostMessage(<pxt.editor.NativeHostMessage>{
        name: resp.downloadFileBaseName,
        download: out
    })
    return Promise.resolve();
}

function nativeHostSaveCoreAsync(resp: pxtc.CompileResult): Promise<void> {
    log(`native save`)
    core.infoNotification(lf("Saving file..."));
    const out = resp.outfiles[pxt.outputName()]
    const nativePostMessage = nativeHostPostMessageFunction();
    nativePostMessage(<pxt.editor.NativeHostMessage>{
        name: resp.downloadFileBaseName,
        save: out
    })
    return Promise.resolve();
}

export function hidDeployCoreAsync(resp: pxtc.CompileResult, d?: pxt.commands.DeployOptions): Promise<void> {
    pxt.tickEvent(`hid.deploy`);    
    log(`hid deploy`)
    // error message handled in browser download
    if (!resp.success)
        return browserDownloadDeployCoreAsync(resp);
    core.infoNotification(lf("Downloading..."));
    return pxt.packetio.initAsync()
        .then(dev => dev.reflashAsync(resp))
        .catch((e) => {
            if (e.type === "repairbootloader") {
                return pairBootloaderAsync()
                    .then(() => hidDeployCoreAsync(resp))
            }
            if (e.type === "devicenotfound" && d.reportDeviceNotFoundAsync) {
                pxt.tickEvent("hid.flash.devicenotfound");
                const troubleshootDoc = pxt.appTarget?.appTheme?.appFlashingTroubleshoot;
                return d.reportDeviceNotFoundAsync(troubleshootDoc, resp);
            } else {
                return pxt.commands.saveOnlyAsync(resp);
            }
        });
}

function pairBootloaderAsync(): Promise<void> {
    log(`pair bootloader`)
    return core.confirmAsync({
        header: lf("Just one more time..."),
        body: lf("You need to pair the board again, now in bootloader mode. We know..."),
        agreeLbl: lf("Ok, pair!")
    }).then(r => pxt.usb.pairAsync())
}

function winrtDeployCoreAsync(r: pxtc.CompileResult, d: pxt.commands.DeployOptions): Promise<void> {
    log(`winrt deploy`)
    return hidDeployCoreAsync(r, d)
        .timeout(20000)
        .catch((e) => {
            return pxt.packetio.disconnectWrapperAsync()
                .catch((e) => {
                    // Best effort disconnect; at this point we don't even know the state of the device
                    pxt.reportException(e);
                })
                .then(() => {
                    return core.confirmAsync({
                        header: lf("Something went wrong..."),
                        body: lf("Flashing your {0} took too long. Please disconnect your {0} from your computer and try reconnecting it.", pxt.appTarget.appTheme.boardName || lf("device")),
                        disagreeLbl: lf("Ok"),
                        hideAgree: true
                    });
                })
                .then(() => {
                    return pxt.commands.saveOnlyAsync(r);
                });
        });
}

function localhostDeployCoreAsync(resp: pxtc.CompileResult): Promise<void> {
    log('local deploy');
    core.infoNotification(lf("Uploading..."));
    let deploy = () => pxt.Util.requestAsync({
        url: "/api/deploy",
        headers: { "Authorization": Cloud.localToken },
        method: "POST",
        data: resp,
        allowHttpErrors: true // To prevent "Network request failed" warning in case of error. We're not actually doing network requests in localhost scenarios
    }).then(r => {
        if (r.statusCode !== 200) {
            core.errorNotification(lf("There was a problem, please try again"));
        } else if (r.json["boardCount"] === 0) {
            core.warningNotification(lf("Please connect your {0} to your computer and try again", pxt.appTarget.appTheme.boardName));
        }
    });

    return deploy()
}

function winrtSaveAsync(resp: pxtc.CompileResult) {
    return pxt.winrt.saveOnlyAsync(resp)
        .then((saved) => {
            if (saved) {
                core.infoNotification(lf("file saved!"));
            }
        })
        .catch((e) => core.errorNotification(lf("saving file failed...")));
}

export function setExtensionResult(res: pxt.editor.ExtensionResult) {
    extensionResult = res;
    applyExtensionResult();
}

function applyExtensionResult() {
    const res = extensionResult;
    if (!res) return;

    if (res.mkPacketIOWrapper) {
        log(`extension mkPacketIOWrapper`)
        pxt.packetio.mkPacketIOWrapper = res.mkPacketIOWrapper;
    }
    if (res.deployAsync) {
        log(`extension deploy core async`);
        pxt.commands.deployCoreAsync = res.deployAsync;
    }
    if (res.saveOnlyAsync) {
        log(`extension save only async`);
        pxt.commands.saveOnlyAsync = res.saveOnlyAsync;
    }
    if (res.saveProjectAsync) {
        log(`extension save project async`);
        pxt.commands.saveProjectAsync = res.saveProjectAsync;
    }
    if (res.showUploadInstructionsAsync) {
        log(`extension upload instructions async`);
        pxt.commands.showUploadInstructionsAsync = res.showUploadInstructionsAsync;
    }
    if (res.patchCompileResultAsync) {
        log(`extension build patch`);
        pxt.commands.patchCompileResultAsync = res.patchCompileResultAsync;
    }
    if (res.blocklyPatch) {
        log(`extension blockly patch`);
        pxt.blocks.extensionBlocklyPatch = res.blocklyPatch;
    }
    if (res.webUsbPairDialogAsync) {
        log(`extension webusb pair dialog`);
        pxt.commands.webUsbPairDialogAsync = res.webUsbPairDialogAsync;
    }
    if (res.onTutorialCompleted) {
        log(`extension tutorial completed`);
        pxt.commands.onTutorialCompleted = res.onTutorialCompleted;
    }
}

export function init(): void {
    pxt.onAppTargetChanged = () => {
        log('app target changed')
        init()
    }
    pxt.packetio.mkPacketIOWrapper = pxt.HF2.mkPacketIOWrapper;

    // reset commands to browser
    pxt.commands.deployCoreAsync = browserDownloadDeployCoreAsync;
    pxt.commands.browserDownloadAsync = browserDownloadAsync;
    pxt.commands.saveOnlyAsync = browserDownloadDeployCoreAsync;
    pxt.commands.showUploadInstructionsAsync = showUploadInstructionsAsync;
    // used by CLI pxt.commands.deployFallbackAsync = undefined;

    // check if webUSB is available and usable
    if (pxt.usb.isAvailable() && pxt.appTarget.compile.webUSB) {
        log(`enabled webusb`);
        pxt.usb.setEnabled(true);
        pxt.packetio.mkPacketIOAsync = pxt.usb.mkPacketIOAsync;
    } else {
        log(`enabled hid bridge (webusb disabled)`);
        pxt.usb.setEnabled(false);
        pxt.packetio.mkPacketIOAsync = hidbridge.mkBridgeAsync;
    }

    const forceBrowserDownload = /force(Hex)?(Browser)?Download/i.test(window.location.href);
    const shouldUseWebUSB = pxt.usb.isEnabled && pxt.appTarget.compile.webUSB;
    if (forceBrowserDownload || pxt.appTarget.serial.noDeploy) {
        log(`deploy: force browser download`);
        // commands are ready
    } else if (isNativeHost()) {
        log(`deploy: webkit deploy/save`);
        pxt.commands.deployCoreAsync = nativeHostDeployCoreAsync;
        pxt.commands.saveOnlyAsync = nativeHostSaveCoreAsync;
    } else if (pxt.winrt.isWinRT()) { // windows app
        log(`deploy: winrt`)
        if (pxt.appTarget.serial && pxt.appTarget.serial.useHF2) {
            log(`winrt deploy`);
            pxt.winrt.initWinrtHid(() => pxt.packetio.initAsync(true).then(() => { }), () => pxt.packetio.disconnectWrapperAsync());
            pxt.packetio.mkPacketIOAsync = pxt.winrt.mkPacketIOAsync;
            pxt.commands.deployCoreAsync = winrtDeployCoreAsync;
        } else {
            // If we're not using HF2, then the target is using their own deploy logic in extension.ts, so don't use
            // the wrapper callbacks
            log(`winrt + custom deploy`);
            pxt.winrt.initWinrtHid(null, null);
            if (pxt.appTarget.serial && pxt.appTarget.serial.rawHID)
                pxt.packetio.mkPacketIOAsync = pxt.winrt.mkPacketIOAsync;
            pxt.commands.deployCoreAsync = pxt.winrt.driveDeployCoreAsync;
        }
        pxt.commands.browserDownloadAsync = pxt.winrt.browserDownloadAsync;
        pxt.commands.saveOnlyAsync = winrtSaveAsync;
    } else if (pxt.BrowserUtils.isPxtElectron()) {
        log(`deploy: electron`);
        pxt.commands.deployCoreAsync = electron.driveDeployAsync;
        pxt.commands.electronDeployAsync = electron.driveDeployAsync;
    } else if (shouldUseWebUSB && pxt.appTarget.appTheme.autoWebUSBDownload) {
        log(`deploy: webusb auto deploy`);
        pxt.commands.deployCoreAsync = webusb.webUsbDeployCoreAsync;
    } else if (shouldUseWebUSB && tryPairedDevice) {
        log(`deploy: webusb, paired once`);
        pxt.commands.deployCoreAsync = webusb.webUsbDeployCoreAsync;
    } else if (hidbridge.shouldUse()) {
        log(`deploy: hid`);
        pxt.commands.deployCoreAsync = hidDeployCoreAsync;
    } else if (pxt.BrowserUtils.isLocalHost() && Cloud.localToken) { // local node.js
        log(`deploy: localhost`);
        pxt.commands.deployCoreAsync = localhostDeployCoreAsync;
    } else { // in browser
        log(`deploy: browser only`);
        // commands are ready
    }

    applyExtensionResult();
}

export function setWebUSBPaired(enabled: boolean) {
    if (tryPairedDevice === enabled) return;
    tryPairedDevice = enabled;
    init();
}

function handlePacketIOApi(r: string) {
    const p = data.stripProtocol(r);
    switch(p) {
        case "connected":
            return pxt.packetio.isConnected();
        case "icon":
            return "usb";
    }
    return false;
}
data.mountVirtualApi("packetio", {
    getSync: handlePacketIOApi
});
