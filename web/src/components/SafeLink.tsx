import { Link, type LinkProps } from "react-router-dom";
import { confirmLeave } from "../unsaved";

// 跟 Link 一樣，只是有沒存的修改時先問一聲，老師按「取消」就留在原頁
export default function SafeLink(props: LinkProps) {
  return (
    <Link
      {...props}
      onClick={(e) => {
        if (!confirmLeave()) {
          e.preventDefault();
          return;
        }
        props.onClick?.(e);
      }}
    />
  );
}
