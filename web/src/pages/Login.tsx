import { useEffect, useState } from "react";
import { api } from "../api";

// 後端登入失敗時帶 ?login_error=代碼 回來，這裡換成老師看得懂的話＋該怎麼做
const LOGIN_ERRORS: Record<string, string> = {
  cancelled: "你在 Google 的畫面按了取消。要使用 classAI，請再按一次「用 Google 帳號登入」，並按「允許」。",
  scopes:
    "有權限沒有勾到。classAI 需要讀取 Classroom 課程、作業、學生名單和雲端硬碟裡的作業檔案，請重新登入，在 Google 的畫面把每一項都打勾。",
  expired: "登入畫面停留太久，已經失效了。請再按一次「用 Google 帳號登入」。",
  no_refresh:
    "Google 這次沒有給完整的授權。請到 Google 帳號的「第三方應用程式」頁面移除 classAI，再回來重新登入一次。",
  failed: "登入沒有成功，請再試一次。一直失敗的話，請換一個瀏覽器（建議 Chrome）再試。",
};

// 只讀不改：React 開發模式會故意把 useState 的初始函式跑兩次，這裡如果順手改網址，第二次就讀不到了
function readLoginError(): string {
  const code = new URLSearchParams(window.location.search).get("login_error");
  return code ? LOGIN_ERRORS[code] ?? LOGIN_ERRORS.failed : "";
}

export default function Login({ notice }: { notice?: string }) {
  const [loginError] = useState(readLoginError);
  const [going, setGoing] = useState(false);

  // 畫面顯示之後再把網址上的代碼拿掉，重新整理時不會一直顯示同一個錯誤
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("login_error")) return;
    params.delete("login_error");
    const rest = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (rest ? `?${rest}` : ""));
  }, []);
  const message = loginError || notice;

  return (
    <div className="container login-screen">
      <img className="login-illust" src="/illust/login.webp" alt="" width={220} height={220} />
      <h1 className="login-title">classAI</h1>
      <p className="login-subtitle">讓 AI 先幫你看過全班的 Google Classroom 作業，給建議分數和評語，你再確認。</p>
      {message && (
        <div className="login-notice" role="alert">
          {message}
          {loginError === LOGIN_ERRORS.no_refresh && (
            <>
              {" "}
              <a href="https://myaccount.google.com/connections" target="_blank" rel="noopener noreferrer">
                打開 Google 帳號設定
              </a>
            </>
          )}
        </div>
      )}
      <button
        className="primary-lg"
        disabled={going}
        onClick={() => {
          // 按一次就鎖住：避免連點送出好幾次登入，第二次會因為驗證碼對不上而失敗
          setGoing(true);
          window.location.href = api.loginUrl();
        }}
      >
        {going ? "前往 Google 登入中…" : "用 Google 帳號登入"}
      </button>
      <p className="login-hint">請用在 Google Classroom 開課的那個帳號登入，個人 Gmail 帳號也可以開課，登入不同的帳號會找不到課程。</p>
      <a className="login-guide-link" href="/guide/">📘 詳細使用說明（圖文教學）</a>
      <ul className="login-trust">
        <li>AI 的分數只是草稿，不會自動寫回 Classroom</li>
        <li>作業內容會交給 Google Gemini 產生評分建議</li>
        <li>評分標準由你決定，隨時可以修改</li>
      </ul>
      <a className="powered-by login-powered-by" href="https://www.hunglun.com/" target="_blank" rel="noreferrer">
        <img src="/hunglun-logo.png?v=2" alt="鴻綸科技" />
        <span>由鴻綸科技提供</span>
      </a>
    </div>
  );
}
