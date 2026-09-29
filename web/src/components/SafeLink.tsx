import { Link, useNavigate, type LinkProps } from "react-router-dom";
import { confirmLeave, hasPending } from "../unsaved";

// 跟 Link 一樣，只是有沒存的修改時先問一聲，老師按「留在這裡」就留在原頁
export default function SafeLink(props: LinkProps) {
  const navigate = useNavigate();
  return (
    <Link
      {...props}
      onClick={(e) => {
        if (hasPending() && !e.defaultPrevented) {
          // 對話框是非同步的：先擋下這次跳轉，問完老師同意再自己換頁
          e.preventDefault();
          confirmLeave().then((ok) => {
            if (ok) navigate(props.to, { state: props.state, replace: props.replace });
          });
          return;
        }
        props.onClick?.(e);
      }}
    />
  );
}
