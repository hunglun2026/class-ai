import { api } from "../api";

export default function Login() {
  return (
    <div className="container" style={{ textAlign: "center", marginTop: 80 }}>
      <h1>作業 AI 評分</h1>
      <p>用 Google 帳號登入，授權讀取 Google Classroom 作業繳交內容。</p>
      <button onClick={() => (window.location.href = api.loginUrl())}>使用 Google 登入</button>
    </div>
  );
}
