import { api } from "../api";

export default function Login() {
  return (
    <div className="container login-screen">
      <img className="login-illust" src="/illust/login.webp" alt="" width={220} height={220} />
      <h1 className="login-title">classAI</h1>
      <p className="login-subtitle">讓 AI 先幫你看過全班的 Google Classroom 作業，給建議分數和評語，你再確認。</p>
      <button className="primary-lg" onClick={() => (window.location.href = api.loginUrl())}>
        用 Google 帳號登入
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
