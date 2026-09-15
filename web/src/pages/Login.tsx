import { api } from "../api";

export default function Login() {
  return (
    <div className="container login-screen">
      <h1 className="login-title">classAI</h1>
      <p className="login-subtitle">用 Google 帳號登入，讀取 Google Classroom 作業繳交內容，讓 AI 幫你先看過一輪。</p>
      <button onClick={() => (window.location.href = api.loginUrl())}>使用 Google 登入</button>
      <a className="powered-by login-powered-by" href="https://www.hunglun.com/" target="_blank" rel="noreferrer">
        <img src="/hunglun-logo.png?v=2" alt="鴻綸科技" />
        <span>由鴻綸科技提供</span>
      </a>
    </div>
  );
}
