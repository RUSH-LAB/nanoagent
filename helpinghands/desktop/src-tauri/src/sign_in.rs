//! The window's sign-in, in macOS's own sign-in sheet over the window (ASWebAuthenticationSession):
//! GitHub's passkeys work there, as they do not in the window, and the sheet hands what the site
//! answers (rushlab://sign-in?state=&token=) back to this app alone, never to the browser or to
//! another copy of the app.

use std::cell::RefCell;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_authentication_services::{
    ASPresentationAnchor, ASWebAuthenticationPresentationContextProviding, ASWebAuthenticationSession,
    ASWebAuthenticationSessionErrorCode,
};
use objc2_foundation::{NSError, NSString, NSURL};
use tauri::{Url, WebviewWindow};

define_class!(
    /// What the sheet is shown over: the app's window.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = Retained<NSObject>]
    struct Anchor;

    unsafe impl NSObjectProtocol for Anchor {}

    unsafe impl ASWebAuthenticationPresentationContextProviding for Anchor {
        #[unsafe(method_id(presentationAnchorForWebAuthenticationSession:))]
        fn anchor(&self, _session: &ASWebAuthenticationSession) -> Retained<ASPresentationAnchor> {
            self.ivars().clone()
        }
    }
);

thread_local! {
    // The sheet showing, kept until it ends: the session holds its anchor weakly, and nothing else holds the session.
    static SHOWING: RefCell<Option<(Retained<ASWebAuthenticationSession>, Retained<Anchor>)>> = const { RefCell::new(None) };
}

/// Show `page` in the sign-in sheet over `window`, on the main thread. `done` gets the rushlab: URL
/// the site ends it with, None when the member closes the sheet, or why it failed.
pub fn show(window: &WebviewWindow, page: Url, done: impl Fn(Result<Option<Url>, String>) + 'static) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("the sign-in sheet opens on the main thread")?;
    let ns_window = window.ns_window().map_err(|error| error.to_string())?;
    // The window outlives the sheet, which only borrows it.
    let ns_window = unsafe { Retained::retain(ns_window.cast::<NSObject>()) }.ok_or("RUSH Lab has no window")?;
    let anchor: Retained<Anchor> = {
        let this = Anchor::alloc(mtm).set_ivars(ns_window);
        unsafe { msg_send![super(this), init] }
    };
    let completion = RcBlock::new(move |url: *mut NSURL, error: *mut NSError| {
        SHOWING.with(|showing| showing.borrow_mut().take());
        let result = match (unsafe { url.as_ref() }, unsafe { error.as_ref() }) {
            (Some(url), _) => url
                .absoluteString()
                .ok_or_else(|| "the sign-in ended with no address".to_string())
                .and_then(|text| Url::parse(&text.to_string()).map_err(|error| error.to_string()))
                .map(Some),
            (None, Some(error)) if error.code() == ASWebAuthenticationSessionErrorCode::CanceledLogin.0 => Ok(None),
            (None, Some(error)) => Err(error.localizedDescription().to_string()),
            (None, None) => Err("the sign-in ended with neither an answer nor an error".into()),
        };
        done(result);
    });
    let url = NSURL::URLWithString(&NSString::from_str(page.as_str())).ok_or("the sign-in page is not a URL")?;
    // initWithURL:callback:completionHandler: needs macOS 14.4; this one works on every macOS the app runs on.
    #[allow(deprecated)]
    let session = unsafe {
        ASWebAuthenticationSession::initWithURL_callbackURLScheme_completionHandler(
            ASWebAuthenticationSession::alloc(),
            &url,
            Some(&NSString::from_str("rushlab")),
            RcBlock::as_ptr(&completion),
        )
    };
    unsafe {
        session.setPresentationContextProvider(Some(ProtocolObject::from_ref(&*anchor)));
        // Safari's sign-ins carry over: a member signed in to GitHub there signs in here with one click.
        session.setPrefersEphemeralWebBrowserSession(false);
    }
    if !unsafe { session.start() } {
        return Err("macOS would not open the sign-in sheet".into());
    }
    SHOWING.with(|showing| *showing.borrow_mut() = Some((session, anchor)));
    Ok(())
}
