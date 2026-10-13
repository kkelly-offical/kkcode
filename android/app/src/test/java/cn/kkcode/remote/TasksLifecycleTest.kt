package cn.kkcode.remote

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.LifecycleObserver
import androidx.lifecycle.LifecycleOwner
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test

class TasksLifecycleTest {
    @Before fun setMainDispatcher() { Dispatchers.setMain(StandardTestDispatcher()) }
    @After fun resetMainDispatcher() { Dispatchers.resetMain() }

    @Test fun detailPollingStopsOnStopAndResumesOnStartWithoutExtraRequests() = runTest {
        val lifecycle = TestLifecycle()
        var requests = 0
        val polling = launch {
            lifecycle.pollTaskDetailsWhileStarted(active = { true }) { requests++ }
        }
        runCurrent()
        try {
            lifecycle.start()
            runCurrent()
            advanceTimeBy(2999)
            runCurrent()
            assertEquals(0, requests)
            advanceTimeBy(1)
            runCurrent()
            assertEquals(1, requests)

            lifecycle.stop()
            runCurrent()
            advanceTimeBy(9000)
            runCurrent()
            assertEquals(1, requests)

            lifecycle.start()
            runCurrent()
            assertEquals(1, requests)
            advanceTimeBy(3000)
            runCurrent()
            assertEquals(2, requests)
        } finally {
            lifecycle.destroy()
            runCurrent()
            polling.join()
        }
    }

    private class TestLifecycle : Lifecycle() {
        private val observers = mutableListOf<LifecycleObserver>()
        private val owner = object : LifecycleOwner {
            override val lifecycle: Lifecycle get() = this@TestLifecycle
        }
        override var currentState = State.CREATED
            private set

        override fun addObserver(observer: LifecycleObserver) { observers += observer }
        override fun removeObserver(observer: LifecycleObserver) { observers -= observer }

        fun start() {
            currentState = State.STARTED
            dispatch(Event.ON_START)
        }

        fun stop() {
            currentState = State.CREATED
            dispatch(Event.ON_STOP)
        }

        fun destroy() {
            currentState = State.DESTROYED
            dispatch(Event.ON_DESTROY)
        }

        private fun dispatch(event: Event) {
            observers.toList().forEach { (it as LifecycleEventObserver).onStateChanged(owner, event) }
        }
    }
}
