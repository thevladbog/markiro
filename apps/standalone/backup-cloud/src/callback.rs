//! Native-only loopback callback. No callback values are webview events.
use crate::{model::Secret, Error, Result};
use aws_lc_rs::constant_time::verify_slices_are_equal;
use std::{collections::BTreeMap, net::SocketAddr, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

#[derive(Debug)]
pub struct AuthorizationCode {
    pub state: Secret,
    pub code: Secret,
}
pub struct CallbackListener {
    listener: TcpListener,
}
impl CallbackListener {
    pub async fn bind() -> Result<Self> {
        Ok(Self {
            listener: TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 45711)).await?,
        })
    }
    pub fn local_addr(&self) -> std::io::Result<SocketAddr> {
        self.listener.local_addr()
    }
    pub async fn receive(self, expected_state: &Secret) -> Result<AuthorizationCode> {
        tokio::time::timeout(Duration::from_secs(600),async {
            loop {
                let (mut stream,peer)=self.listener.accept().await?;
                if !peer.ip().is_loopback() {continue;}
                let request=tokio::time::timeout(Duration::from_secs(5),async {
                    let mut bytes=Vec::with_capacity(4096);let mut buffer=[0;1024];
                    loop {
                        let n=stream.read(&mut buffer).await?;
                        if n==0 {return Err(Error::InvalidAttempt);}
                        bytes.extend_from_slice(&buffer[..n]);
                        if bytes.len()>12288 {return Err(Error::SizeLimit);}
                        if bytes.windows(4).any(|w|w==b"\r\n\r\n") {break;}
                    }
                    let text=std::str::from_utf8(&bytes).map_err(|_|Error::InvalidAttempt)?;
                    let mut lines=text.split("\r\n");
                    let first=lines.next().ok_or(Error::InvalidAttempt)?;
                    let parts:Vec<_>=first.split(' ').collect();
                    if parts.len()!=3 || parts[0]!="GET" || parts[2]!="HTTP/1.1" {return Err(Error::InvalidAttempt);}
                    let mut host_count=0;
                    for line in lines.take_while(|line|!line.is_empty()) {
                        let (key,value)=line.split_once(':').ok_or(Error::InvalidAttempt)?;
                        if key.eq_ignore_ascii_case("host") { host_count+=1;if value.trim()!="127.0.0.1:45711" {return Err(Error::InvalidAttempt);} }
                        if key.eq_ignore_ascii_case("content-length") && value.trim()!="0" {return Err(Error::InvalidAttempt);}
                        if key.eq_ignore_ascii_case("transfer-encoding") {return Err(Error::InvalidAttempt);}
                    }
                    if host_count!=1 {return Err(Error::InvalidAttempt);}
                    parse_callback(parts[1],expected_state)
                }).await;
                let result=match request {Ok(result)=>result,Err(_)=>Err(Error::InvalidAttempt)};
                let terminal=result.is_ok() || matches!(&result,Err(Error::Provider("cancelled")));
                let answer=if terminal {"HTTP/1.1 200 OK\r\nContent-Length: 35\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\nAuthorization received. Return now."}
                    else {"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"};
                // A browser that has gone away must not discard a valid code.
                let _=tokio::time::timeout(Duration::from_secs(2),stream.write_all(answer.as_bytes())).await;
                if terminal {return result;}
            }
        }).await.map_err(|_|Error::InvalidAttempt)?
    }
}

pub fn parse_callback(target: &str, expected_state: &Secret) -> Result<AuthorizationCode> {
    if target.len() > 10000
        || !target.starts_with("/oauth/yandex/callback?")
        || target.contains('#')
    {
        return Err(Error::InvalidAttempt);
    }
    let url = reqwest::Url::parse(&format!("http://127.0.0.1:45711{target}"))
        .map_err(|_| Error::InvalidAttempt)?;
    if url.path() != "/oauth/yandex/callback" {
        return Err(Error::InvalidAttempt);
    }
    let mut fields = BTreeMap::new();
    for (key, value) in url.query_pairs() {
        if !matches!(
            key.as_ref(),
            "code" | "state" | "cid" | "error" | "error_description"
        ) || fields
            .insert(key.into_owned(), value.into_owned())
            .is_some()
        {
            return Err(Error::InvalidAttempt);
        }
    }
    // Yandex may append a correlation id. It is not an identity or a CSRF token.
    // Accept only a bounded opaque value; duplicates remain rejected above.
    if fields.remove("cid").is_some_and(|cid| {
        cid.is_empty()
            || cid.len() > 200
            || !cid
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    }) {
        return Err(Error::InvalidAttempt);
    }
    let state = fields.remove("state").ok_or(Error::InvalidAttempt)?;
    if verify_slices_are_equal(state.as_bytes(), expected_state.expose().as_bytes()).is_err() {
        return Err(Error::InvalidAttempt);
    }
    if let Some(error) = fields.remove("error") {
        if fields.contains_key("code")
            || error.is_empty()
            || error.len() > 128
            || !error
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_')
        {
            return Err(Error::InvalidAttempt);
        }
        return Err(Error::Provider("cancelled"));
    }
    if fields.contains_key("error_description") {
        return Err(Error::InvalidAttempt);
    }
    let code = fields.remove("code").ok_or(Error::InvalidAttempt)?;
    if code.len() > 4096 {
        return Err(Error::SizeLimit);
    }
    Ok(AuthorizationCode {
        state: Secret::new(state)?,
        code: Secret::new(code)?,
    })
}
