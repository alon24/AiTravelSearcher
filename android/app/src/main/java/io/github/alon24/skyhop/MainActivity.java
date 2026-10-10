package io.github.alon24.skyhop;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.Toast;

import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.regex.Pattern;

/**
 * Skyhop on Android: the Skyhop web app in one tab and the airline's own site in a second one, so "Select on site"
 * can find the flight there the way the desktop Airline Assist extension does. The extension's own scripts run in
 * the Skyhop page (assets/skyhop-app.js, built by tools/build_android.py); this class only carries their calls
 * between the two tabs.
 */
public class MainActivity extends Activity {
    private static final String HOME = BuildConfig.SKYHOP_URL;
    private static final Uri HOME_URI = Uri.parse(HOME);
    private static final Pattern TOKEN = Pattern.compile("[A-Za-z0-9_-]{1,8000}");

    private WebView app, airline;
    private Button appTab, airlineTab;
    // Read by the page's script thread (tabState), written by the web views' callbacks.
    private volatile String appUrl = "", airlineUrl = "", airlineStatus = "complete";
    private boolean signingIn = false, gotToken = false;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        app = webView();
        airline = webView();
        appTab = tab("Skyhop", v -> show(app));
        airlineTab = tab("Airline site", v -> show(airline));
        airlineTab.setEnabled(false);

        LinearLayout bar = new LinearLayout(this);
        bar.addView(appTab, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        bar.addView(airlineTab, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        FrameLayout pages = new FrameLayout(this);
        pages.addView(app);
        pages.addView(airline);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setFitsSystemWindows(true);
        root.addView(bar);
        root.addView(pages, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);

        setUpApp();
        setUpAirline();
        show(app);
        app.loadUrl(HOME);
        handle(getIntent());
    }

    private WebView webView() {
        WebView w = new WebView(this);
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, true);
        return w;
    }

    private Button tab(String label, View.OnClickListener onClick) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setOnClickListener(onClick);
        return b;
    }

    private void show(WebView page) {
        app.setVisibility(page == app ? View.VISIBLE : View.GONE);
        airline.setVisibility(page == airline ? View.VISIBLE : View.GONE);
        appTab.setTextColor(page == app ? getColor(R.color.brand) : Color.GRAY);
        airlineTab.setTextColor(page == airline ? getColor(R.color.brand) : Color.GRAY);
    }

    private boolean isSkyhop(Uri u) {
        return "https".equals(u.getScheme()) && HOME_URI.getHost().equals(u.getHost())
                && u.getPath() != null && u.getPath().startsWith(HOME_URI.getPath());
    }

    /** Not a web page (mailto:, intent:): the phone's own app for it, if any. */
    private void openOutside(Uri u) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "No app on this phone opens " + u.getScheme() + ": links", Toast.LENGTH_LONG).show();
        }
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void setUpApp() {
        app.addJavascriptInterface(new AppBridge(), "SkyhopNative");
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            String origin = HOME_URI.getScheme() + "://" + HOME_URI.getHost();
            WebViewCompat.addDocumentStartJavaScript(app, asset("skyhop-app.js"), Collections.singleton(origin));
        } else {
            Toast.makeText(this, "Airline Assist needs a newer Android System WebView: update it from the Play Store", Toast.LENGTH_LONG).show();
        }
        app.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (isSkyhop(u)) return false;
                // Airline sites, Google Flights and the rest open in the airline tab, inside the app.
                if ("https".equals(u.getScheme()) || "http".equals(u.getScheme())) openAirline(u.toString());
                else openOutside(u);
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                appUrl = url;
            }

            @Override
            public void doUpdateVisitedHistory(WebView view, String url, boolean reload) {
                appUrl = url;
            }
        });
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void setUpAirline() {
        airline.addJavascriptInterface(new AirlineBridge(), "SkyhopAirline");
        airline.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if ("https".equals(u.getScheme()) || "http".equals(u.getScheme())) return false;
                openOutside(u);
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                airlineUrl = url;
                airlineStatus = "loading";
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                airlineUrl = url;
                airlineStatus = "complete";
            }

            @Override
            public void doUpdateVisitedHistory(WebView view, String url, boolean reload) {
                airlineUrl = url;    // also a site's own pushState, which is how some results pages show the search
            }
        });
    }

    private void openAirline(String url) {
        airlineUrl = url;
        airlineStatus = "loading";
        airline.loadUrl(url);
        airlineTab.setEnabled(true);
        show(airline);
    }

    private String asset(String name) {
        try (InputStream in = getAssets().open(name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[65536];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (IOException e) {
            throw new IllegalStateException("the app was built without " + name + " (run tools/build_android.py)", e);
        }
    }

    private void dispatch(String event, String detailJson) {
        app.evaluateJavascript("window.dispatchEvent(new CustomEvent(" + JSONObject.quote(event) + ",{detail:" + detailJson + "}))", null);
    }

    // ------------------------------------------------------------------------------------------- sign-in hand-back
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handle(intent);
    }

    /** skyhop://signed-in?t=...: the token the phone's browser got from Google (account.js appToken reads it). */
    private void handle(Intent intent) {
        Uri u = intent == null ? null : intent.getData();
        if (u == null || !"skyhop".equals(u.getScheme()) || !"signed-in".equals(u.getHost())) return;
        String t = u.getQueryParameter("t");
        if (t == null || !TOKEN.matcher(t).matches()) return;
        gotToken = true;
        signingIn = false;
        show(app);
        dispatch("skyhop-app-token", "{raw:" + JSONObject.quote(t) + "}");
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (signingIn && !gotToken) {    // back from the browser without signing in
            signingIn = false;
            dispatch("skyhop-app-token", "{error:\"Sign-in was cancelled in the browser\"}");
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (airline.getVisibility() == View.VISIBLE) {
            if (airline.canGoBack()) airline.goBack();
            else show(app);
        } else if (app.canGoBack()) app.goBack();
        else super.onBackPressed();
    }

    // --------------------------------------------------------------------------------------------- the two bridges
    /** window.SkyhopNative in the Skyhop tab: what assets/skyhop-app.js needs from the app. Answers only Skyhop. */
    private class AppBridge {
        private boolean fromSkyhop() {
            return isSkyhop(Uri.parse(appUrl));
        }

        @JavascriptInterface
        public void openTab(String url) {
            Uri u = Uri.parse(url);
            if (!fromSkyhop() || !("https".equals(u.getScheme()) || "http".equals(u.getScheme()))) return;
            runOnUiThread(() -> openAirline(url));
        }

        @JavascriptInterface
        public String tabState() {
            try {
                return new JSONObject().put("url", airlineUrl).put("status", airlineStatus).toString();
            } catch (JSONException e) {
                return "{}";
            }
        }

        /** Runs `code` in the airline tab; its JSON result goes back as SkyhopShim.done(id, result). */
        @JavascriptInterface
        public void exec(String id, String code) {
            if (!fromSkyhop()) return;
            runOnUiThread(() -> airline.evaluateJavascript(code, value ->
                    app.evaluateJavascript("SkyhopShim.done(" + JSONObject.quote(id) + "," + value + ")", null)));
        }

        @JavascriptInterface
        public void toAirline(String id, String json) {
            if (!fromSkyhop()) return;
            runOnUiThread(() -> airline.evaluateJavascript(
                    "window.__skyhopBridge&&__skyhopBridge.reply(" + JSONObject.quote(id) + "," + JSONObject.quote(json) + ")", null));
        }

        /** Google sign-in in the phone's browser (app.js appSignInPage), which comes back as skyhop://signed-in. */
        @JavascriptInterface
        public void signIn(String scope, String hint) {
            if (!fromSkyhop()) return;
            Uri u = HOME_URI.buildUpon().appendQueryParameter("app-sign-in", "1")
                    .appendQueryParameter("scope", scope).appendQueryParameter("hint", hint).build();
            runOnUiThread(() -> {
                signingIn = true;
                gotToken = false;
                openOutside(u);
            });
        }

        @JavascriptInterface
        public String version() {
            return BuildConfig.VERSION_NAME;
        }
    }

    /** window.SkyhopAirline in the airline tab: the drivers' questions for Jev, handed to the Skyhop tab (which takes
        only Assist's own message types). */
    private class AirlineBridge {
        @JavascriptInterface
        public void send(String id, String json) {
            runOnUiThread(() -> app.evaluateJavascript(
                    "window.SkyhopShim&&SkyhopShim.fromAirline(" + JSONObject.quote(id) + "," + JSONObject.quote(json) + ")", null));
        }
    }
}
