---
title: 'Decorating JVM Stack Traces for Fun and Profit'
description: 'How to extend OpenJDK to enrich stack traces with runtime metadata like OTEL trace IDs, span attributes, and application context.'
pubDate: 'Mar 12 2026'
---

## Intro
Last year I had an opportunity to do some hacking on the OpenJDK fork that my employer maintains internally and I want to capture what I learned about JDK development in general and the specific topic of how to decorate jvm stack traces with application specific metadata. This blog post and linked repos are an attempt at doing just that and I'm doing it for the benefit of future me, as much as anyone else who might be interested. If you're wondering why a SaaS company like ServiceNow maintains a fork of OpenJDK, besides having a fork of JavaScript engine (my main area of work) and a fork of Postgres, I know I hear you.. I guess the [not invented here](https://en.wikipedia.org/wiki/Not_invented_here) is strong at ServiceNow. I'm not complaining, it gave me a rare opportunity to really dive deep into one of the most foundational technologies of our era. In what will probably turn out to be a short series of blog posts, I'm going to explore how to build a custom image of JDK from sources, including some basic extensions like adding a new class [Java Class Library](https://en.wikipedia.org/wiki/Java_Class_Library) or extending existing one, then move on to the main topic which is digging into how JVM stack traces are created and how one might go about enriching call frames with more application level data.

## Why would I ever want any of that?
Good question! Curiosity about how things are put together and the joy of tinkering is an obvious answer, but of course you might have a particular goal in mind.  Like that bit of functionality you always wanted to add to the Java standard library or perhaps you were curious if you can implement a Garbage Collector. The topic I worked on and will cover here, stack trace decoration, is much less ambitious than a new GC, but maybe you can treat it as a starting point?

My stack traces are fine, I hear you say, what else could I possibly want to add to them? Frankly many complain that the JVM stack traces already have too much information in them (or at least way too many frames). 

The use case I was working on, which sadly I can't cover in full details, was related to that JavaScript engine (fork of [mozilla/rhino](https://github.com/mozilla/rhino)) I mentioned earlier. Since we're running JavaScript on JVM, we often have useful metadata about the code being run that we wanted to pass on to the JVM at runtime, so that when a stack trace is constructed, this information can be included. The goal being to make the stack trace much more relatable to the JavaScript code users wrote and less to the JVM and rhino internals. I don't want to get into too many details, but think about call frames representing JavaScript functions you wrote being easy to find on the stack trace vs being shown [org.mozilla.rhino.Interpreter.interpretLoop](https://github.com/mozilla/rhino/blob/4bf1df91036c7627f817d037aa768c3f79a9f8d8/rhino/src/main/java/org/mozilla/javascript/Interpreter.java#L1571) and other rhino internal call frames. For example, say you have this JavaScript code:

```js
function g(x) {
    throw new Error("something went wrong: " + x);
}
function f(x) {
    return g(x);
}
f(42);
```

Here is what the JVM stack trace actually looks like:

```sh
java.lang.Exception
    at org.mozilla.javascript.MemberBox.newInstance(MemberBox.java:246)
    at org.mozilla.javascript.NativeJavaClass.constructInternal(NativeJavaClass.java:240)
    at org.mozilla.javascript.NativeJavaClass.construct(NativeJavaClass.java:150)
    at org.mozilla.javascript.Interpreter.interpretLoop(Interpreter.java:2076)
    at org.mozilla.javascript.Interpreter.interpret(Interpreter.java:1109)
    at org.mozilla.javascript.InterpretedFunction.call(InterpretedFunction.java:87)
    ...
```

Where are `f` and `g`? Nowhere to be found. Wouldn't it be great if at least some of the frames were showing `f` and `g` ? I understand this is quite a niche use case, few people might have this problem, but it hopefully illustrates the more general pattern. You might be interested in decorating the JVM stack trace with some other application or business domain level information, so that the frames are related to your business logic and your mental model of the problem the code is solving, making debugging issues so much easier. Let's give a few examples, to make this more concrete. 

Perhaps you're labelling your servers/pods/threads with some unique tag to help make sense from logs and other telemetry. Well if you could set that unique tag on the JVM process start up and have each frame decorated with it, that would mean each time stack trace is printed (like in thrown and caught exception), you know exactly where it originated from. Each thread being tagged with a unique tag might also be a very handy idea, because you can probably find machine Id in the logs, but each machine might have many JVM processes running many threads, so having unique threadId in the stack trace might be interesting to some, especially if you can give your threads some logical names/ids. This idea becomes even more powerful with the arrival of Project Loom and its potential of "millions" of virtual threads. Moving your application to leverage thousands of virtual threads, it's becoming increasingly challenging to depend on Thread name or ThreadLocal, which were the typical ways to preserve that sort of logical context. This use case extends quite naturally into Kotlin coroutines and async frameworks where it's often a challenge to reconstruct what was the logical stack trace from the "physical" JVM level frames. If you're not interested in servers, how about the service name and version, set at deployment? How many times have you looked at the exception and wondered: is this process running the latest version?

Another telemetry related idea, is that if you collect some runtime metrics like maybe number of in-flight transactions, number of concurrent users or similar throughput/latency related metrics, wouldn't it be awesome to attach those to exception stack trace an a time exception is thrown? So that you can later see that this error happened when your metric was close to its P99 value. 

Finally that leaves us to the most interesting use case in my opinion, which is integrating telemetry from frameworks like OTEL into your frames. Even something as simple as decorating frames with the active trace ID and span ID at the time they were entered you could automatically correlate any exception thrown with the rest of your distributed trace without all the current plumbing that usually depends on injecting those IDs into your logging framework. Again, this could be game changing for async and reactive code where context propagation is usually challenging. But wait, there is more! One could imagine decorating frames with OTEL span attributes and other semantic context. Think things like `http.method`, `http.route`, `db.system` etc. How powerful would that be to see stack frames showing `POST /api/orders`, `env: PROD` and `postgres: dev-DB` right there in the exception stack trace:

```sh
java.sql.SQLTransientConnectionException: Connection refused to host: dev-db.internal:5432
    at com.zaxxer.hikari.pool.HikariPool.createTimeoutException(HikariPool.java:696)
    at com.example.orders.OrderRepository.findById(OrderRepository.java:42)
        [trace=8cbd5293... span=7a28297b... db.system=postgres db.name=dev-DB]
    at com.example.orders.OrderService.getOrder(OrderService.java:38)
        [trace=8cbd5293... span=6f19cc4a... op=getOrder env=PROD]
    at com.example.orders.OrderController.getOrder(OrderController.java:27)
        [trace=8cbd5293... span=3d5e8b12... http.method=POST http.route=/api/orders]
    at java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(DirectMethodHandleAccessor.java:104)
    ...
```
Wait, why is PROD service trying to connect to `dev-DB` ?!? Well, exactly!

I hope by now I've convinced you that this would be useful and you probably have a lot of questions about the feasibility of it, not to mention the performance cost. I'm going to cover all of it in future posts, the goal of this series of blog posts will be to walk you dear reader through JDK changes required to do a good demo of the use cases we covered above, the most ambitious one being an OTEL-like telemetry being added into your stack frames, just like that example above. I'll also cover relevant JVM internals and the development process, so that you can follow along if you want to.  Along the JDK changes, I'm going to implement a sample demo app to show how to use our custom JVM, its new APIs and how they could be leveraged to build this cool instrumentation into our app. I'm saying "OTEL-like", because I'm probably not going to fork OTEL and integrate everything with them, but the aim is to make it look very similar to how you annotate your app with OTEL spans, so that it's pretty obvious that it could be done with the real framework. 

If that sounds interesting, I'm inviting you to [Part 2](/blog/jvm-stack-decorator-part-2), where we're going to start by learning how to develop on OpenJDK locally and how to build custom JVM image.  
