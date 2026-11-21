// 前端构建产物 (web/dist) 由 rust-embed 编进二进制: 产物变了 (含从无到有) 就重编本 crate
fn main() {
    println!("cargo:rerun-if-changed=web/dist");
}
