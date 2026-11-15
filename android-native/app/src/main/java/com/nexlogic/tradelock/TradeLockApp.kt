package com.nexlogic.tradelock

import android.app.Application
import com.nexlogic.tradelock.data.Api

class TradeLockApp : Application() {
    override fun onCreate() {
        super.onCreate()
        instance = this
        Api.init(this)
    }

    companion object {
        /** The app context, for things that ring or start services outside a screen (the price alarm). */
        lateinit var instance: TradeLockApp
            private set
    }
}
